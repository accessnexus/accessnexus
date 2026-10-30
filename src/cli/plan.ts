// ============================================
// Live-database change plan (`diff --against-db`, `push --dry-run` with a URL).
//
// The plan is computed by REHEARSAL: run.ts opens a transaction, captures a
// catalog snapshot of everything the schema manages, applies exactly what push
// would apply, captures the snapshot again and rolls back. This module holds
// the pure parts: the snapshot queries, normalization, the diff, the risk rules
// and the human rendering.
// ============================================

import { paint } from './output.js';

export type PlanKind = 'table' | 'column' | 'constraint' | 'index' | 'rls' | 'policy' | 'trigger' | 'function' | 'grant';

export interface SnapshotEntry {
  kind: PlanKind;
  /** Qualified name, e.g. `public.notes`, `public.notes.body`, `public.notes.accessnexus_notes_select`, `public.fn(uuid)`. */
  object: string;
  props: Record<string, unknown>;
}

/** Normalized catalog snapshot, keyed by `${kind}:${object}`. */
export type CatalogSnapshot = Record<string, SnapshotEntry>;

export interface PlanChange {
  kind: PlanKind;
  object: string;
  change: 'added' | 'removed' | 'modified';
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  /** For `modified`: the properties that differ. */
  fields?: string[];
  /**
   * Grants only: how each role's effective access changed, e.g.
   * `anon EXECUTE: via PUBLIC → direct grant (no change in access)`.
   */
  notes?: string[];
}

export type RiskCode =
  | 'table_dropped'
  | 'column_dropped'
  | 'column_type_changed'
  | 'column_default_removed'
  | 'column_nullability_relaxed'
  | 'rls_disabled'
  | 'policy_dropped'
  | 'policy_roles_widened'
  | 'policy_permissive_changed'
  | 'trigger_dropped'
  | 'function_dropped'
  | 'function_volatility_changed'
  | 'function_config_changed'
  | 'function_security_changed'
  | 'grant_widened'
  | 'grant_narrowed';

export interface RiskyChange {
  code: RiskCode;
  kind: PlanKind;
  object: string;
  message: string;
}

export interface SnapshotScope {
  tables: Array<{ schema: string; table: string }>;
  /** Functions named in the SQL push applies (RPCs, trigger functions, helpers). */
  functions: Array<{ schema: string; name: string }>;
  /** Functions to include by oid (the ones an earlier snapshot captured). */
  functionOids?: number[];
}

const SNAPSHOT_FUNCTION_OIDS = new WeakMap<CatalogSnapshot, number[]>();

/** Oids of the functions a snapshot captured (to capture the same set again). */
export function snapshotFunctionOids(snapshot: CatalogSnapshot): number[] {
  return SNAPSHOT_FUNCTION_OIDS.get(snapshot) ?? [];
}

/** Roles whose EFFECTIVE access the plan compares (PUBLIC = the ACL's PUBLIC entry). */
export const PLAN_ROLES = ['PUBLIC', 'anon', 'authenticated'] as const;
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

/** `has_*_privilege` for anon/authenticated, false when the role does not exist. */
function effectiveSql(fn: 'has_function_privilege' | 'has_table_privilege', oid: string, privileges: string[]): string {
  return `ARRAY(SELECT r.rolname || '=' || pr.p
                  FROM unnest(ARRAY['anon', 'authenticated']) AS r(rolname)
                 CROSS JOIN unnest(ARRAY[${privileges.map((p) => `'${p}'`).join(', ')}]) AS pr(p)
                 WHERE CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles x WHERE x.rolname = r.rolname)
                            THEN pg_catalog.${fn}(r.rolname, ${oid}, pr.p) ELSE false END)`;
}

/** `role=PRIV` entries of the effective access: anon/authenticated from has_*_privilege, PUBLIC from the ACL. */
function effectiveAccess(roleEntries: unknown, privileges: string[]): string[] {
  const publicEntries = privileges
    .filter((p) => p.startsWith('PUBLIC='))
    .map((p) => p.replace(/\*$/, ''));
  return [...new Set([...sortedStrings(roleEntries), ...publicEntries])].sort();
}

/** Properties shown in before/after but not compared (bodyHash already covers them). */
const NOT_COMPARED: Partial<Record<PlanKind, string[]>> = { function: ['definition'] };

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };

const KIND_ORDER: PlanKind[] = ['table', 'rls', 'column', 'constraint', 'index', 'policy', 'trigger', 'function', 'grant'];

/** `CREATE [OR REPLACE] FUNCTION schema.name(` in SQL → the function names it defines. */
export function functionsDefinedIn(sql: string, defaultSchema = 'public'): Array<{ schema: string; name: string }> {
  const out: Array<{ schema: string; name: string }> = [];
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:("?)([A-Za-z_][\w$]*)\1\.)?("?)([A-Za-z_][\w$]*)\3\s*\(/gi;
  for (const match of sql.matchAll(re)) {
    const schema = match[2] === undefined ? defaultSchema : match[1] ? match[2] : match[2].toLowerCase();
    const name = match[3] ? match[4] : match[4].toLowerCase();
    if (!out.some((f) => f.schema === schema && f.name === name)) out.push({ schema, name });
  }
  return out;
}

function sortedStrings(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : parsePgArray(String(value));
  return list.map(String).sort();
}

/** `{a,b}` text form of a Postgres array (pg returns name[] as a string for some types). */
function parsePgArray(text: string): string[] {
  const inner = text.replace(/^\{|\}$/g, '');
  if (inner === '') return [];
  return inner.split(',').map((s) => s.replace(/^"|"$/g, ''));
}

const VOLATILITY: Record<string, string> = { i: 'IMMUTABLE', s: 'STABLE', v: 'VOLATILE' };
const POLICY_CMD: Record<string, string> = { r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE', '*': 'ALL' };
const CONSTRAINT_TYPE: Record<string, string> = { p: 'PRIMARY KEY', f: 'FOREIGN KEY', u: 'UNIQUE', c: 'CHECK', x: 'EXCLUDE', t: 'TRIGGER' };

/** Decode pg_trigger.tgtype into timing / events / level. */
export function decodeTriggerType(tgtype: number): { timing: string; events: string[]; level: string } {
  const timing = tgtype & 64 ? 'INSTEAD OF' : tgtype & 2 ? 'BEFORE' : 'AFTER';
  const events: string[] = [];
  if (tgtype & 4) events.push('INSERT');
  if (tgtype & 16) events.push('UPDATE');
  if (tgtype & 8) events.push('DELETE');
  if (tgtype & 32) events.push('TRUNCATE');
  return { timing, events, level: tgtype & 1 ? 'ROW' : 'STATEMENT' };
}

/**
 * Capture the normalized catalog state of everything the schema manages:
 * tables (+ RLS, columns, constraints, indexes, policies, triggers, grants) and
 * the functions the generated SQL defines or the managed triggers call.
 */
export async function captureSnapshot(client: Queryable, scope: SnapshotScope): Promise<CatalogSnapshot> {
  const snapshot: CatalogSnapshot = {};
  const put = (kind: PlanKind, object: string, props: Record<string, unknown>) => {
    snapshot[`${kind}:${object}`] = { kind, object, props };
  };
  const tSchemas = scope.tables.map((t) => t.schema);
  const tNames = scope.tables.map((t) => t.table);

  const tables = (await client.query(
    `SELECT c.oid, n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity,
            ARRAY(SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END
                         || '=' || a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END
                    FROM pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) a) AS privileges,
            ${effectiveSql('has_table_privilege', 'c.oid', TABLE_PRIVILEGES)} AS effective
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN unnest($1::text[], $2::text[]) AS m(schema_name, table_name)
         ON n.nspname = m.schema_name AND c.relname = m.table_name
      WHERE c.relkind IN ('r', 'p')`,
    [tSchemas, tNames],
  )).rows;
  const oids = tables.map((t) => Number(t.oid));
  for (const t of tables) {
    const name = `${t.nspname}.${t.relname}`;
    put('table', name, {});
    put('rls', name, { enabled: t.relrowsecurity === true, forced: t.relforcerowsecurity === true });
    const privileges = sortedStrings(t.privileges);
    put('grant', `table ${name}`, { privileges, effective: effectiveAccess(t.effective, privileges) });
  }

  const triggerFunctionOids = new Set<number>();
  if (oids.length > 0) {
    const columns = (await client.query(
      `SELECT n.nspname, c.relname, a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
              a.attnotnull, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_expr, a.attidentity, a.attgenerated
         FROM pg_catalog.pg_attribute a
         JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped`,
      [oids],
    )).rows;
    for (const c of columns) {
      put('column', `${c.nspname}.${c.relname}.${c.attname}`, {
        type: String(c.type),
        notNull: c.attnotnull === true,
        default: c.attgenerated ? null : (c.default_expr ?? null),
        identity: c.attidentity ? (c.attidentity === 'a' ? 'ALWAYS' : 'BY DEFAULT') : null,
        generated: c.attgenerated ? (c.default_expr ?? null) : null,
      });
    }

    const constraints = (await client.query(
      `SELECT n.nspname, c.relname, k.conname, k.contype, pg_catalog.pg_get_constraintdef(k.oid) AS def
         FROM pg_catalog.pg_constraint k
         JOIN pg_catalog.pg_class c ON c.oid = k.conrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE k.conrelid = ANY($1::oid[])`,
      [oids],
    )).rows;
    for (const k of constraints) {
      put('constraint', `${k.nspname}.${k.relname}.${k.conname}`, {
        type: CONSTRAINT_TYPE[String(k.contype)] ?? String(k.contype),
        definition: String(k.def),
      });
    }

    const indexes = (await client.query(
      `SELECT n.nspname, c.relname AS table_name, i.relname AS index_name, pg_catalog.pg_get_indexdef(x.indexrelid) AS def
         FROM pg_catalog.pg_index x
         JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
         JOIN pg_catalog.pg_class c ON c.oid = x.indrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = i.relnamespace
        WHERE x.indrelid = ANY($1::oid[])
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conindid = x.indexrelid AND k.conrelid = x.indrelid)`,
      [oids],
    )).rows;
    for (const i of indexes) {
      put('index', `${i.nspname}.${i.index_name}`, { table: `${i.nspname}.${i.table_name}`, definition: String(i.def) });
    }

    const policies = (await client.query(
      `SELECT n.nspname, c.relname, p.polname, p.polcmd, p.polpermissive,
              ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(r) END FROM unnest(p.polroles) r) AS roles,
              pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS using_expr,
              pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
         FROM pg_catalog.pg_policy p
         JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE p.polrelid = ANY($1::oid[])`,
      [oids],
    )).rows;
    for (const p of policies) {
      put('policy', `${p.nspname}.${p.relname}.${p.polname}`, {
        command: POLICY_CMD[String(p.polcmd)] ?? String(p.polcmd),
        permissive: p.polpermissive === true,
        roles: sortedStrings(p.roles),
        using: p.using_expr ?? null,
        withCheck: p.check_expr ?? null,
      });
    }

    const triggers = (await client.query(
      `SELECT n.nspname, c.relname, t.tgname, t.tgtype, t.tgenabled, t.tgfoid,
              t.tgfoid::regprocedure::text AS function, pg_catalog.pg_get_triggerdef(t.oid) AS def
         FROM pg_catalog.pg_trigger t
         JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE t.tgrelid = ANY($1::oid[]) AND NOT t.tgisinternal`,
      [oids],
    )).rows;
    for (const t of triggers) {
      triggerFunctionOids.add(Number(t.tgfoid));
      const when = /\sWHEN\s+\((.*)\)\s+EXECUTE\s/s.exec(String(t.def));
      put('trigger', `${t.nspname}.${t.relname}.${t.tgname}`, {
        ...decodeTriggerType(Number(t.tgtype)),
        when: when ? when[1] : null,
        function: String(t.function),
        enabled: String(t.tgenabled) !== 'D',
      });
    }
  }

  const functions = (await client.query(
    `SELECT n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
            pg_catalog.pg_get_function_result(p.oid) AS returns, l.lanname, p.provolatile, p.prosecdef,
            p.proisstrict, p.proconfig, md5(p.prosrc) AS body_hash, pg_catalog.pg_get_functiondef(p.oid) AS def,
            ARRAY(SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END
                         || '=' || a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END
                    FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a) AS privileges,
            ${effectiveSql('has_function_privilege', 'p.oid', ['EXECUTE'])} AS effective, p.oid
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_catalog.pg_language l ON l.oid = p.prolang
      WHERE p.prokind IN ('f', 'p')
        AND ((n.nspname, p.proname) IN (SELECT * FROM unnest($1::text[], $2::text[])) OR p.oid = ANY($3::oid[]))`,
    [scope.functions.map((f) => f.schema), scope.functions.map((f) => f.name), [...triggerFunctionOids, ...(scope.functionOids ?? [])]],
  )).rows;
  SNAPSHOT_FUNCTION_OIDS.set(snapshot, functions.map((f) => Number(f.oid)));
  for (const f of functions) {
    const name = `${f.nspname}.${f.proname}(${f.args})`;
    put('function', name, {
      returns: String(f.returns),
      language: String(f.lanname),
      volatility: VOLATILITY[String(f.provolatile)] ?? String(f.provolatile),
      securityDefiner: f.prosecdef === true,
      strict: f.proisstrict === true,
      config: sortedStrings(f.proconfig),
      bodyHash: String(f.body_hash),
      definition: String(f.def),
    });
    const privileges = sortedStrings(f.privileges);
    put('grant', `function ${name}`, { privileges, effective: effectiveAccess(f.effective, privileges) });
  }

  return snapshot;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Compare two snapshots. Changes come out ordered by kind, then object name. */
export function diffSnapshots(before: CatalogSnapshot, after: CatalogSnapshot): PlanChange[] {
  const changes: PlanChange[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const a = before[key];
    const b = after[key];
    if (a && !b) {
      changes.push({ kind: a.kind, object: a.object, change: 'removed', before: a.props });
    } else if (!a && b) {
      changes.push({ kind: b.kind, object: b.object, change: 'added', after: b.props });
    } else if (a && b) {
      const skip = NOT_COMPARED[a.kind] ?? [];
      const fields = [...new Set([...Object.keys(a.props), ...Object.keys(b.props)])]
        .filter((field) => !skip.includes(field) && !same(a.props[field], b.props[field]));
      if (fields.length > 0) {
        const change: PlanChange = { kind: a.kind, object: a.object, change: 'modified', before: a.props, after: b.props, fields };
        if (a.kind === 'grant') {
          const notes = grantAccessChanges(a.props, b.props)
            .map((x) => `${describeAccess(x)}${x.role === 'PUBLIC' && x.change === 'lost' ? PUBLIC_LOST_NOTE : ACCESS_NOTE[x.change]}`);
          if (notes.length > 0) change.notes = notes;
        }
        changes.push(change);
      }
    }
  }
  return changes.sort((x, y) =>
    KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) || x.object.localeCompare(y.object));
}

const KIND_LABEL: Record<PlanKind, string> = {
  table: 'Tables', rls: 'Row level security', column: 'Columns', constraint: 'Constraints', index: 'Indexes',
  policy: 'Policies', trigger: 'Triggers', function: 'Functions', grant: 'Grants',
};

/** How `role` holds `privilege`: `via PUBLIC`, `direct grant`, `role membership` or `none`. */
function accessSource(role: string, privilege: string, props: Record<string, unknown>): string {
  const literal = ((props.privileges as string[]) ?? []).map((p) => p.replace(/\*$/, ''));
  const effective = (props.effective as string[]) ?? [];
  if (!effective.includes(`${role}=${privilege}`)) return 'none';
  if (role === 'PUBLIC') return 'granted';
  if (literal.includes(`${role}=${privilege}`)) return 'direct grant';
  if (literal.includes(`PUBLIC=${privilege}`)) return 'via PUBLIC';
  return 'role membership';
}

/**
 * Per role and privilege: the effective-access changes of a modified grant.
 * `lost`/`gained` drive the risk; `same` (access unchanged, ACL shape changed)
 * only becomes a note.
 */
const ACCESS_NOTE = { same: ' (no change in access)', lost: ' (access lost)', gained: ' (access gained)' } as const;
// PUBLIC's own entry: anon/authenticated may keep access through a direct grant.
const PUBLIC_LOST_NOTE = ' (PUBLIC entry removed; see anon/authenticated)';

function describeAccess(x: { role: string; privilege: string; from: string; to: string }): string {
  return `${x.role} ${x.privilege}: ${x.from} → ${x.to}`;
}

function grantAccessChanges(before: Record<string, unknown>, after: Record<string, unknown>) {
  const b = new Set((before.effective as string[]) ?? []);
  const a = new Set((after.effective as string[]) ?? []);
  const entries = [...new Set([...b, ...a])].sort();
  const out: Array<{ role: string; privilege: string; change: 'lost' | 'gained' | 'same'; from: string; to: string }> = [];
  for (const entry of entries) {
    const [role, privilege] = entry.split('=');
    const from = accessSource(role, privilege, before);
    const to = accessSource(role, privilege, after);
    const change = b.has(entry) && !a.has(entry) ? 'lost' : !b.has(entry) && a.has(entry) ? 'gained' : 'same';
    if (change === 'same' && from === to) continue;
    out.push({ role, privilege, change, from, to });
  }
  return out;
}

function fmt(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (Array.isArray(value)) return value.length === 0 ? '[]' : value.join(', ');
  return String(value);
}

/** Flag the changes a reviewer must look at before pushing. */
export function findRiskyChanges(changes: PlanChange[]): RiskyChange[] {
  const risky: RiskyChange[] = [];
  const add = (code: RiskCode, c: PlanChange, message: string) => risky.push({ code, kind: c.kind, object: c.object, message });
  const isRemoved = (kind: PlanKind, object: string) => changes.some((c) => c.kind === kind && c.object === object && c.change === 'removed');

  for (const c of changes) {
    const before = c.before ?? {};
    const after = c.after ?? {};
    const changed = (field: string) => c.fields?.includes(field) === true;

    if (c.change === 'removed') {
      if (c.kind === 'table') add('table_dropped', c, `table ${c.object} is dropped`);
      if (c.kind === 'column') {
        const table = c.object.slice(0, c.object.lastIndexOf('.'));
        if (!isRemoved('table', table)) add('column_dropped', c, `column ${c.object} is dropped`);
      }
      if (c.kind === 'policy') add('policy_dropped', c, `policy ${c.object} (${fmt(before.command)}) is dropped`);
      if (c.kind === 'trigger') add('trigger_dropped', c, `trigger ${c.object} is dropped`);
      if (c.kind === 'function') add('function_dropped', c, `function ${c.object} is dropped`);
      continue;
    }

    if (c.kind === 'grant') {
      // Risk is judged on EFFECTIVE access (has_*_privilege), not on the ACL's
      // literal shape: anon losing a direct grant it also has via PUBLIC
      // changes nothing. A brand-new function/table is granted to PUBLIC by
      // default: only grants on objects that already existed are judged.
      if (c.change !== 'modified') continue;
      const access = grantAccessChanges(before, after);
      // PUBLIC losing a privilege anon and authenticated both keep (the
      // definer-RPC REVOKE ... FROM PUBLIC + direct GRANT) is not a narrowing
      // for the Supabase API roles: it stays a note.
      const keeps = (role: string, privilege: string) => ((after.effective as string[]) ?? []).includes(`${role}=${privilege}`);
      const lost = access.filter((x) => x.change === 'lost'
        && !(x.role === 'PUBLIC' && keeps('anon', x.privilege) && keeps('authenticated', x.privilege)));
      const gained = access.filter((x) => x.change === 'gained');
      if (lost.length > 0) add('grant_narrowed', c, `${c.object} loses access: ${lost.map(describeAccess).join('; ')}`);
      if (gained.length > 0) add('grant_widened', c, `${c.object} newly grants access: ${gained.map(describeAccess).join('; ')}`);
      continue;
    }

    if (c.change !== 'modified') continue;

    if (c.kind === 'column') {
      if (changed('type')) add('column_type_changed', c, `column ${c.object} type ${fmt(before.type)} → ${fmt(after.type)}`);
      if (changed('default') && before.default !== null && after.default === null) {
        add('column_default_removed', c, `column ${c.object} loses its default (${fmt(before.default)})`);
      }
      if (changed('notNull') && before.notNull === true) add('column_nullability_relaxed', c, `column ${c.object} becomes nullable`);
    }
    if (c.kind === 'rls') {
      if (before.enabled === true && after.enabled !== true) add('rls_disabled', c, `row level security is disabled on ${c.object}`);
      else if (before.forced === true && after.forced !== true) add('rls_disabled', c, `FORCE ROW LEVEL SECURITY is removed on ${c.object}`);
    }
    if (c.kind === 'policy') {
      if (changed('roles')) {
        const beforeRoles = (before.roles as string[]) ?? [];
        const afterRoles = (after.roles as string[]) ?? [];
        const added = afterRoles.filter((r) => !beforeRoles.includes(r));
        // `public` already covers every role: nothing widens it.
        const widened = !beforeRoles.includes('public') && added.length > 0;
        if (widened) add('policy_roles_widened', c, `policy ${c.object} roles ${fmt(beforeRoles)} → ${fmt(afterRoles)}`);
      }
      if (changed('permissive')) {
        add('policy_permissive_changed', c, `policy ${c.object} ${before.permissive ? 'PERMISSIVE' : 'RESTRICTIVE'} → ${after.permissive ? 'PERMISSIVE' : 'RESTRICTIVE'}`);
      }
    }
    if (c.kind === 'function') {
      if (changed('volatility')) add('function_volatility_changed', c, `function ${c.object} ${fmt(before.volatility)} → ${fmt(after.volatility)}`);
      if (changed('config')) add('function_config_changed', c, `function ${c.object} config [${fmt(before.config)}] → [${fmt(after.config)}]`);
      if (changed('securityDefiner')) {
        add('function_security_changed', c, `function ${c.object} ${before.securityDefiner ? 'SECURITY DEFINER' : 'SECURITY INVOKER'} → ${after.securityDefiner ? 'SECURITY DEFINER' : 'SECURITY INVOKER'}`);
      }
    }
  }
  return risky;
}

export function summarizeChanges(changes: PlanChange[]): { added: number; modified: number; removed: number } {
  const summary = { added: 0, modified: 0, removed: 0 };
  for (const c of changes) summary[c.change] += 1;
  return summary;
}

/** One-line summary of an added/removed object. */
export function describeProps(kind: PlanKind, props: Record<string, unknown>): string {
  switch (kind) {
    case 'column':
      return [props.type, props.notNull ? 'not null' : null, props.default != null ? `default ${props.default}` : null].filter(Boolean).join(', ');
    case 'rls':
      return `enabled: ${props.enabled}, forced: ${props.forced}`;
    case 'policy':
      return `${props.command} to ${fmt(props.roles)}${props.permissive ? '' : ', restrictive'}`;
    case 'trigger':
      return `${props.timing} ${fmt(props.events)} ${props.level} → ${props.function}`;
    case 'function':
      return [props.language, props.volatility, props.securityDefiner ? 'SECURITY DEFINER' : null,
        (props.config as string[] | undefined)?.length ? `SET ${fmt(props.config)}` : null].filter(Boolean).join(', ');
    case 'grant':
      return fmt(props.privileges);
    case 'constraint':
      return String(props.definition ?? '');
    default:
      return '';
  }
}

/** Human output: changes grouped by kind, modified fields as `before → after`. */
export function renderPlan(changes: PlanChange[], risky: RiskyChange[]): string[] {
  const lines: string[] = [];
  const riskyKeys = new Set(risky.map((r) => `${r.kind}:${r.object}`));
  for (const kind of KIND_ORDER) {
    const group = changes.filter((c) => c.kind === kind);
    if (group.length === 0) continue;
    lines.push(paint.bold(`  ${KIND_LABEL[kind]}:`));
    for (const c of group) {
      const mark = c.change === 'added' ? paint.green('+') : c.change === 'removed' ? paint.red('-') : paint.yellow('~');
      const flag = riskyKeys.has(`${c.kind}:${c.object}`) ? ` ${paint.red('(risky)')}` : '';
      const detail = c.change === 'modified' ? '' : describeProps(c.kind, (c.after ?? c.before)!);
      lines.push(`    ${mark} ${c.object}${detail ? paint.gray(` (${detail})`) : ''}${flag}`);
      if (c.change === 'modified') {
        for (const note of c.notes ?? []) lines.push(`        ${note}`);
        for (const field of c.fields ?? []) {
          if (c.kind === 'grant' && field === 'effective' && c.notes?.length) continue;
          if (field === 'bodyHash') {
            lines.push(`        body: ${paint.gray('changed')}`);
            continue;
          }
          lines.push(`        ${field}: ${fmt(c.before?.[field])} → ${fmt(c.after?.[field])}`);
        }
      }
    }
    lines.push('');
  }
  if (risky.length > 0) {
    lines.push(paint.red(paint.bold(`  ⚠ Risky changes: ${risky.length}`)));
    for (const r of risky) lines.push(`    ${paint.red('!')} [${r.code}] ${r.message}`);
    lines.push('');
  }
  return lines;
}
