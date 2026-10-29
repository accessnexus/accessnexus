// ============================================
// AccessNexus - Full Database Introspection (direct Postgres)
// --------------------------------------------
// Unlike the PostgREST/OpenAPI path (introspect.ts), a direct `pg` connection
// can read EVERYTHING the schema needs: tables, columns, PK/FK/unique, and the
// parts REST cannot expose — RLS policies (pg_policies) and functions (pg_proc).
// Use this whenever a database URL is available; it is the faithful path for
// adopting an existing project with dozens of policies and functions.
//
// `pg` is a peer dependency loaded dynamically (same as push/seed).
// ============================================

import { dbConnectTimeoutMs } from '../db-timeout.js';
import type {
  IntrospectedPolicy,
  IntrospectedTable,
  IntrospectionResult,
} from './introspect.js';

export interface IntrospectedFunction {
  name: string;
  args: string; // pg_get_function_arguments, e.g. "p_id uuid, p_amount numeric"
  returns: string; // pg_get_function_result
  language: string; // plpgsql | sql | ...
  security: 'invoker' | 'definer';
  volatility: 'immutable' | 'stable' | 'volatile';
  /** pg_proc.proconfig as `{ name: value }` (e.g. `{ search_path: 'public', row_security: 'off' }`). */
  config: Record<string, string>;
  body: string; // prosrc (inner body)
}

/** Parse pg_proc.proconfig (`{"search_path=public","row_security=off"}`) into a map. */
export function parseProconfig(raw: unknown): Record<string, string> {
  const entries: string[] = Array.isArray(raw) ? raw.map(String) : [];
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

export interface DbIntrospectionResult extends IntrospectionResult {
  functions: IntrospectedFunction[];
}

// PostGIS / system tables that live in public but should not become schema.
const SYSTEM_TABLES = new Set([
  'spatial_ref_sys',
  'geography_columns',
  'geometry_columns',
  'raster_columns',
  'raster_overviews',
  // push's own bookkeeping table
  'accessnexus_migrations',
]);

// pg_attribute rather than information_schema: it gives the exact type
// (format_type: numeric(10,2), varchar(20)), enum labels, identity/generated
// flags and the default expression.
const COLUMNS_SQL = `
SELECT c.relname AS table_name, a.attname AS column_name, t.typname AS udt_name,
       format_type(a.atttypid, a.atttypmod) AS formatted_type,
       CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
       pg_get_expr(d.adbin, d.adrelid) AS column_default,
       a.attnum AS ordinal_position,
       a.attidentity::text AS identity,
       (a.attgenerated <> '') AS generated,
       CASE WHEN t.typtype = 'e' THEN
         (SELECT json_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid)
       END AS enum_values
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_type t ON t.oid = a.atttypid
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY c.relname, a.attnum;`;

// pg_constraint keeps each constraint's columns together (composite PK/UNIQUE/FK)
// and the referenced schema (FKs to auth.users).
const CONSTRAINTS_SQL = `
SELECT c.relname AS table_name, con.conname AS name, con.contype AS type,
       (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns,
       fn.nspname AS foreign_schema, fc.relname AS foreign_table,
       (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS foreign_columns,
       con.confdeltype AS on_delete
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_class fc ON fc.oid = con.confrelid
LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
WHERE n.nspname = 'public' AND con.contype IN ('p', 'f', 'u')
ORDER BY c.relname, con.conname;`;

// User triggers (not the internal ones that implement FKs).
const TRIGGERS_SQL = `
SELECT c.relname AS table_name, t.tgname AS name, t.tgtype::int AS tgtype,
       pg_get_triggerdef(t.oid) AS definition, t.tgnargs::int AS nargs,
       (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(t.tgattr::int2[]) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k.attnum) AS update_columns,
       (t.tgconstraint <> 0) AS is_constraint, t.tgenabled::text AS enabled,
       p.proname AS function_name, pn.nspname AS function_schema, l.lanname AS language,
       p.prosecdef AS secdef, p.prosrc AS body, p.proconfig::text[] AS config
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_proc p ON p.oid = t.tgfoid
JOIN pg_namespace pn ON pn.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
WHERE n.nspname = 'public' AND NOT t.tgisinternal
ORDER BY c.relname, t.tgname;`;

// roles is name[]; return it as text so every pg version parses it the same.
const POLICIES_SQL = `
SELECT tablename, policyname, cmd, qual, with_check, permissive,
       array_to_string(roles, ',') AS roles
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;`;

const RLS_SQL = `
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p');`;

// User functions only — exclude anything owned by an extension (PostGIS, etc).
const FUNCTIONS_SQL = `
SELECT p.proname AS name,
       pg_get_function_arguments(p.oid) AS args,
       pg_get_function_result(p.oid) AS returns,
       l.lanname AS language,
       p.prosecdef AS secdef,
       p.provolatile AS volatility,
       p.proconfig::text[] AS config,
       p.prosrc AS body
FROM pg_proc p
JOIN pg_namespace ns ON ns.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
WHERE ns.nspname = 'public'
  AND p.prokind = 'f'
  -- Trigger / event-trigger handlers are not callable RPCs; exclude them.
  AND p.prorettype NOT IN ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype)
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
ORDER BY p.proname;`;

interface ConstraintRow {
  table_name: string;
  name: string;
  type: 'p' | 'f' | 'u';
  columns: string[] | null;
  foreign_schema: string | null;
  foreign_table: string | null;
  foreign_columns: string[] | null;
  /** confdeltype: a no action, r restrict, c cascade, n set null, d set default */
  on_delete: string | null;
}

const ON_DELETE: Record<string, 'cascade' | 'set null' | 'restrict'> = { c: 'cascade', n: 'set null', r: 'restrict' };

export async function introspectViaDb(dbUrl: string): Promise<DbIntrospectionResult> {
  const client = await createPgClient(dbUrl);
  try {
    // One client runs one query at a time: issue them in sequence (pg warns —
    // and will throw in pg@9 — when queries are queued concurrently).
    const cols = await client.query(COLUMNS_SQL);
    const cons = await client.query(CONSTRAINTS_SQL);
    const pols = await client.query(POLICIES_SQL);
    const fns = await client.query(FUNCTIONS_SQL);
    const rls = await client.query(RLS_SQL);
    const trgs = await client.query(TRIGGERS_SQL);

    const tableMap = new Map<string, IntrospectedTable>();
    const ensure = (name: string): IntrospectedTable => {
      let t = tableMap.get(name);
      if (!t) {
        t = { name, columns: [], foreignKeys: [], uniqueColumns: [], policies: [] };
        tableMap.set(name, t);
      }
      return t;
    };

    for (const row of cols.rows as any[]) {
      if (SYSTEM_TABLES.has(row.table_name)) continue;
      ensure(row.table_name).columns.push({
        table_name: row.table_name,
        column_name: row.column_name,
        data_type: row.udt_name,
        udt_name: row.udt_name,
        is_nullable: row.is_nullable,
        column_default: row.column_default ?? null,
        ordinal_position: Number(row.ordinal_position),
        formatted_type: row.formatted_type ?? undefined,
        enum_values: Array.isArray(row.enum_values) ? row.enum_values : undefined,
        identity: row.identity ?? '',
        generated: Boolean(row.generated),
      });
    }

    for (const con of cons.rows as ConstraintRow[]) {
      const t = tableMap.get(con.table_name);
      if (!t) continue;
      const columns = con.columns ?? [];
      if (columns.length === 0) continue;
      if (con.type === 'p') {
        if (columns.length === 1) t.primaryKey = columns[0];
        else t.compositePrimaryKey = columns;
      } else if (con.type === 'f' && con.foreign_table && con.foreign_columns) {
        if (columns.length === 1 && con.foreign_columns.length === 1) {
          const onDelete = ON_DELETE[con.on_delete ?? 'a'];
          t.foreignKeys.push({
            column: columns[0],
            referencedTable: con.foreign_table,
            referencedColumn: con.foreign_columns[0],
            ...(con.foreign_schema && con.foreign_schema !== 'public' ? { referencedSchema: con.foreign_schema } : {}),
            ...(onDelete ? { onDelete } : {}),
          });
        } else {
          const target = `${con.foreign_schema && con.foreign_schema !== 'public' ? `${con.foreign_schema}.` : ''}${con.foreign_table}`;
          (t.compositeForeignKeys ??= []).push(
            `${con.name}: FOREIGN KEY (${columns.join(', ')}) REFERENCES ${target}(${con.foreign_columns.join(', ')})`,
          );
        }
      } else if (con.type === 'u') {
        if (columns.length === 1) {
          if (!t.uniqueColumns.includes(columns[0])) t.uniqueColumns.push(columns[0]);
        } else {
          (t.uniqueGroups ??= []).push(columns);
        }
      }
    }

    for (const row of trgs.rows as any[]) {
      const t = tableMap.get(row.table_name);
      if (!t) continue;
      (t.triggers ??= []).push({
        name: row.name,
        tgtype: Number(row.tgtype),
        definition: row.definition ?? '',
        nargs: Number(row.nargs ?? 0),
        updateColumns: Array.isArray(row.update_columns) ? row.update_columns : [],
        isConstraint: Boolean(row.is_constraint),
        enabled: row.enabled ?? 'O',
        functionName: row.function_name,
        functionSchema: row.function_schema,
        language: row.language,
        security: row.secdef ? 'definer' : 'invoker',
        config: parseProconfig(row.config),
        body: row.body ?? '',
      });
    }

    for (const row of pols.rows as any[]) {
      tableMap.get(row.tablename)?.policies.push({
        tablename: row.tablename,
        policyname: row.policyname,
        cmd: row.cmd,
        qual: row.qual,
        with_check: row.with_check,
        roles: String(row.roles ?? 'public').split(',').map((r) => r.trim()).filter(Boolean),
        permissive: row.permissive === 'RESTRICTIVE' ? 'RESTRICTIVE' : 'PERMISSIVE',
      } satisfies IntrospectedPolicy);
    }

    for (const row of rls.rows as Array<{ table_name: string; rls_enabled: boolean }>) {
      const t = tableMap.get(row.table_name);
      if (t) t.rlsEnabled = Boolean(row.rls_enabled);
    }

    const functions: IntrospectedFunction[] = (fns.rows as any[]).map((r) => ({
      name: r.name,
      args: r.args ?? '',
      returns: r.returns ?? 'void',
      language: r.language ?? 'plpgsql',
      security: r.secdef ? 'definer' : 'invoker',
      volatility: r.volatility === 'i' ? 'immutable' : r.volatility === 's' ? 'stable' : 'volatile',
      config: parseProconfig(r.config),
      body: r.body ?? '',
    }));

    const tables = Array.from(tableMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    return { tables, functions };
  } finally {
    await client.end().catch(() => {});
  }
}

/** Load the `pg` peer dependency dynamically and open a connection. */
async function createPgClient(dbUrl: string): Promise<any> {
  let pg: any;
  try {
    const moduleName = 'pg';
    pg = await import(moduleName);
  } catch (cause) {
    throw new PgDriverMissingError(cause);
  }
  const Client = pg.Client ?? pg.default?.Client;
  const client = new Client({ connectionString: dbUrl, connectionTimeoutMillis: dbConnectTimeoutMs() });
  await client.connect();
  return client;
}

/** The optional `pg` peer dependency is not installed. */
export class PgDriverMissingError extends Error {
  constructor(cause?: unknown) {
    super('the "pg" Postgres driver is not installed', { cause });
    this.name = 'PgDriverMissingError';
  }
}
