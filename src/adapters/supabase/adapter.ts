// ============================================
// AccessNexus - Supabase Adapter
// Generates RLS policies for Supabase/PostgreSQL
// ============================================

import { baseType, isNullable, normalizeColumn } from '../../core/types/columns.js';
import { primaryKeyColumns, singlePrimaryKey } from '../../core/types/schema.js';
import type { RpcArg } from '../../core/types/rpc.js';
import type {
  Adapter,
  GeneratedOutput,
  PolicyOperation,
  PolicyRule,
  RpcDef,
  SchemaDef,
  SeedDef,
  SeedSqlOptions,
  TableDef,
  TriggerEvent,
  TriggerRule,
} from '../../core/types/index.js';

/** Check if a string is a simple column name (not an expression like auth.uid()) */
function isColumnName(value: string): boolean {
  return /^[a-z_][a-z0-9_]*$/i.test(value);
}

/** A GUC name: `work_mem`, `row_security`, or a custom `myapp.setting`. */
const GUC_NAME = /^[a-z_][a-z0-9_$]*(\.[a-z_][a-z0-9_$]*)?$/i;

/**
 * Volatility of an rpc(): `volatility`, else `immutable: true` (alias), else
 * volatile. A contradicting combination throws (validate reports it first).
 */
export function resolveRpcVolatility(name: string, def: { volatility?: string; immutable?: boolean }): 'volatile' | 'stable' | 'immutable' {
  const v = def.volatility;
  if (v !== undefined && v !== 'volatile' && v !== 'stable' && v !== 'immutable') {
    throw new Error(`[AccessNexus] rpc ${name}: volatility must be 'volatile', 'stable' or 'immutable' (got ${JSON.stringify(v)})`);
  }
  if (def.immutable === true && v !== undefined && v !== 'immutable') {
    throw new Error(`[AccessNexus] rpc ${name}: immutable: true conflicts with volatility: '${v}'`);
  }
  if (def.immutable === false && v === 'immutable') {
    throw new Error(`[AccessNexus] rpc ${name}: immutable: false conflicts with volatility: 'immutable'`);
  }
  return v ?? (def.immutable ? 'immutable' : 'volatile');
}

/**
 * `SET key = 'value'` lines for a function's `set` option. Keys must be GUC
 * names (emitted unquoted, so they are validated); values always go through
 * quoteLiteral. `search_path` is skipped: the generator pins its own.
 */
export function functionSetClauses(set: Readonly<Record<string, string>> | undefined, owner: string): string[] {
  if (!set) return [];
  const out: string[] = [];
  for (const key of Object.keys(set).sort()) {
    if (!GUC_NAME.test(key)) {
      throw new Error(`[AccessNexus] ${owner}: set key "${key}" is not a valid configuration parameter name`);
    }
    if (key.toLowerCase() === 'search_path') continue;
    const value = set[key];
    if (typeof value !== 'string') {
      throw new Error(`[AccessNexus] ${owner}: set.${key} must be a string`);
    }
    out.push(`SET ${key.toLowerCase()} = ${quoteLiteral(value)}`);
  }
  return out;
}

/** Quote a value as a SQL string literal (single quotes doubled). */
function quoteLiteral(value: unknown): string {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * Wrap a bare Supabase auth function call (e.g. `auth.uid()`, `auth.jwt()`) in
 * `(SELECT ...)` so Postgres caches it via initPlan instead of re-evaluating it
 * per row. Leaves plain columns and already-wrapped expressions untouched.
 */
function wrapAuthCall(value: string): string {
  if (/^auth\.[a-z_]+\([^)]*\)$/i.test(value.trim())) {
    return `(SELECT ${value.trim()})`;
  }
  return value;
}

/**
 * Options for {@link SupabaseAdapter}. In `accessnexus.config.ts` they go under
 * `adapterOptions` (plus `dbUrlEnv`, read by the CLI for push/seed).
 */
export interface SupabaseAdapterOptions {
  /** Prefix for generated policy names (default: 'accessnexus') */
  policyPrefix?: string;
  /** Schema name (default: 'public') */
  schemaName?: string;
  /** Include DROP IF EXISTS before CREATE (default: true) */
  idempotent?: boolean;
  /** Add timestamp comments (default: true) */
  timestamps?: boolean;
  /** Force RLS for table owners (default: true) */
  forceRLS?: boolean;
  /**
   * UUID generation strategy for primary keys.
   * - `'v4'` — random UUIDs via `gen_random_uuid()` (default)
   * - `'v7'` — time-ordered UUIDs via `accessnexus_uuidv7()` (better index performance)
   *
   * When `'v7'` is selected, a `accessnexus_uuidv7()` helper function is
   * automatically generated in the migration output.
   *
   * @default 'v4'
   */
  uuidGeneration?: 'v4' | 'v7';
  /**
   * Path to the Supabase-generated `database.types.ts` file,
   * relative to the SDK output directory.
   * When set, the generated client imports types from this file
   * instead of generating its own type definitions.
   *
   * @example '../../src/database.types'
   */
  databaseTypes?: string;
  /**
   * Omit the volatile `-- Generated at: <timestamp>` line from output headers
   * so repeated generations are byte-for-byte identical. The rest of the
   * header (title, table name) is kept. Enable for reproducible builds and
   * clean diffs in version control.
   *
   * @default false
   */
  deterministic?: boolean;
}

/**
 * Compiles a AccessNexus schema to Supabase/PostgreSQL: DDL migrations, RLS policies,
 * triggers, RPC functions, seed SQL and a typed client SDK. The CLI uses it for
 * you; call it directly to generate SQL programmatically (tests, custom tooling).
 * Every method is pure: it returns `{ path, content }` files and writes nothing.
 *
 * @example
 * ```ts
 * import { SupabaseAdapter } from 'accessnexus';
 * import schema from './accessnexus.schema';
 *
 * const adapter = new SupabaseAdapter({ policyPrefix: 'app', deterministic: true });
 * for (const file of adapter.generatePolicies(schema)) {
 *   console.log(file.path); // e.g. "profiles_rls.sql"
 * }
 * ```
 */
export class SupabaseAdapter implements Adapter {
  readonly name = 'supabase';
  private options: Required<Omit<SupabaseAdapterOptions, 'databaseTypes'>> & {
    databaseTypes?: string;
  };
  private policyHelperFnBySignature = new Map<string, string>();

  constructor(options: SupabaseAdapterOptions = {}) {
    this.options = {
      policyPrefix: options.policyPrefix ?? 'accessnexus',
      schemaName: options.schemaName ?? 'public',
      idempotent: options.idempotent ?? true,
      timestamps: options.timestamps ?? true,
      forceRLS: options.forceRLS ?? true,
      uuidGeneration: options.uuidGeneration ?? 'v4',
      deterministic: options.deterministic ?? false,
      databaseTypes: options.databaseTypes,
    };
  }

  /**
   * RLS SQL, one `<table>_rls.sql` per table. RLS is enabled and forced on every
   * table (fail closed): a table without `policies` is deny-all for anon and
   * authenticated (service role only). Only `enableRLS: false` skips it.
   */
  generatePolicies(schema: SchemaDef): GeneratedOutput[] {
    const outputs: GeneratedOutput[] = [];

    for (const [tableName, tableDef] of Object.entries(schema)) {
      if (tableDef.enableRLS === false && !tableDef.policies) continue;

      const sql = this.generateTablePolicies(tableName, tableDef);
      outputs.push({
        path: `${tableName}_rls.sql`,
        content: sql,
      });
    }

    return outputs;
  }

  /** Typed SDK files (`types.ts` + `client.ts`, or `client.ts` in Database mode). */
  generateClient(schema: SchemaDef): GeneratedOutput[] {
    // Detect Database mode: all tables have empty columns
    const isDatabaseMode = Object.values(schema).every(
      (t) => Object.keys(t.columns).length === 0
    );

    if (isDatabaseMode) {
      return this.generateDatabaseModeClient(schema);
    }

    // Original manual mode
    const interfaces = this.generateTypeInterfaces(schema);
    const client = this.generateClientCode(schema);

    return [
      { path: 'types.ts', content: interfaces },
      { path: 'client.ts', content: client },
    ];
  }

  /** Full DDL (`001_initial.sql`): enums, tables, FKs, indexes. Empty in Database mode. */
  generateMigrations(schema: SchemaDef): GeneratedOutput[] {
    const tableEntries = Object.entries(schema);
    if (tableEntries.length === 0) return [];

    // Database mode cannot generate DDL because column metadata is not present.
    const isDatabaseMode = tableEntries.every(([, def]) => Object.keys(def.columns).length === 0);
    if (isDatabaseMode) return [];

    const lines: string[] = [];
    const orderedTables = this.orderTablesByDependencies(schema);
    const enumStatements: string[] = [];
    const seenEnums = new Set<string>();

    const { timestamps } = this.options;
    if (timestamps) {
      lines.push(`-- ============================================`);
      lines.push(`-- AccessNexus: Auto-generated migrations`);
      if (!this.options.deterministic) {
        lines.push(`-- Generated at: ${new Date().toISOString()}`);
      }
      lines.push(`-- ============================================`);
      lines.push('');
    }

    for (const tableName of orderedTables) {
      const tableDef = schema[tableName];
      for (const [columnName, rawColumnDef] of Object.entries(tableDef.columns)) {
        const col = normalizeColumn(rawColumnDef);
        const colType = baseType(col.type);
        if (!colType.startsWith('enum(')) continue;

        const enumName = this.enumTypeName(tableName, columnName);
        if (seenEnums.has(enumName)) continue;

        seenEnums.add(enumName);
        enumStatements.push(this.createEnumSQL(enumName, colType));
      }
    }

    if (enumStatements.length > 0) {
      lines.push(...enumStatements);
      lines.push('');
    }

    // UUIDv7 helper function (when opted in and any table has UUID PK)
    if (this.options.uuidGeneration === 'v7') {
      const hasUuidPk = orderedTables.some((t) => {
        const def = schema[t];
        const pk = singlePrimaryKey(def);
        if (!pk || !def.columns[pk]) return false;
        const col = normalizeColumn(def.columns[pk]);
        return baseType(col.type) === 'uuid' && col.default === undefined;
      });
      if (hasUuidPk) {
        lines.push(this.uuidv7FunctionSQL(this.uuidv7NeedsAnon(schema, orderedTables)));
        lines.push('');
      }
    }

    for (const tableName of orderedTables) {
      const tableDef = schema[tableName];
      lines.push(this.generateCreateTableSQL(tableName, tableDef));
      lines.push('');

      const indexes = this.generateIndexesSQL(tableName, tableDef);
      if (indexes.length > 0) {
        lines.push(...indexes);
        lines.push('');
      }
    }

    return [
      {
        path: '001_initial.sql',
        content: lines.join('\n').trimEnd() + '\n',
      },
    ];
  }

  // ---- SQL Generation ----

  private generateTablePolicies(tableName: string, tableDef: TableDef): string {
    const { policyPrefix, idempotent, timestamps, forceRLS } = this.options;
    const lines: string[] = [];
    this.policyHelperFnBySignature.clear();

    // Header
    if (timestamps) {
      lines.push(`-- ============================================`);
      lines.push(`-- AccessNexus: Auto-generated RLS policies`);
      lines.push(`-- Table: ${tableName}`);
      if (!this.options.deterministic) {
        lines.push(`-- Generated at: ${new Date().toISOString()}`);
      }
      lines.push(`-- ============================================`);
      lines.push('');
    }

    // Enable RLS
    lines.push(`ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY;`);
    if (forceRLS) {
      lines.push(`ALTER TABLE ${tableName} FORCE ROW LEVEL SECURITY;`);
    }
    lines.push('');

    // Drop every operation's policy that is not (or no longer) in the schema: removing a
    // rule must revoke the access it granted, not leave the old policy behind.
    const operations: PolicyOperation[] = ['select', 'insert', 'update', 'delete'];
    const absent = operations.filter((op) => !tableDef.policies?.[op]);
    for (const op of absent) {
      lines.push(`DROP POLICY IF EXISTS "${policyPrefix}_${tableName}_${op}" ON ${tableName};`);
    }
    if (absent.length > 0) lines.push('');

    if (!tableDef.policies) {
      lines.push('-- No policies: deny-all for anon and authenticated (service role only).');
      lines.push('');
      return lines.join('\n');
    }

    // Generate each operation's policy
    const helperDefinitions = this.collectPolicyHelpers(tableName, tableDef, operations);
    if (helperDefinitions.length > 0) {
      lines.push(...helperDefinitions);
      lines.push('');
    }

    for (const op of operations) {
      const rule = tableDef.policies?.[op];
      if (!rule) continue;

      const policyName = `${policyPrefix}_${tableName}_${op}`;

      // Drop existing (idempotent)
      if (idempotent) {
        lines.push(`DROP POLICY IF EXISTS "${policyName}" ON ${tableName};`);
      }

      // Generate policy. USING decides which existing rows are visible/targeted;
      // WITH CHECK decides what may be written. UPDATE always gets an explicit
      // WITH CHECK so the written row is held to the same (or stricter) rule.
      const sqlOp = op.toUpperCase();
      const role = this.policyRoleFor(op, rule);

      if (op === 'insert') {
        lines.push(
          `CREATE POLICY "${policyName}"`,
          `  ON ${tableName} FOR INSERT`,
          `  TO ${role}`,
          `  WITH CHECK (`,
          `    ${this.ruleToCheckSQL(rule)}`,
          `  );`,
        );
      } else if (op === 'update') {
        lines.push(
          `CREATE POLICY "${policyName}"`,
          `  ON ${tableName} FOR UPDATE`,
          `  TO ${role}`,
          `  USING (`,
          `    ${this.ruleToSQL(rule)}`,
          `  )`,
          `  WITH CHECK (`,
          `    ${this.ruleToCheckSQL(rule)}`,
          `  );`,
        );
      } else {
        lines.push(
          `CREATE POLICY "${policyName}"`,
          `  ON ${tableName} FOR ${sqlOp}`,
          `  TO ${role}`,
          `  USING (`,
          `    ${this.ruleToSQL(rule)}`,
          `  );`,
        );
      }

      lines.push('');
    }

    return lines.join('\n');
  }

  /** Convert a PolicyRule to a SQL expression */
  ruleToSQL(rule: PolicyRule): string {
    switch (rule.kind) {
      case 'authenticated':
        return '(SELECT auth.uid()) IS NOT NULL';

      case 'public':
        return 'TRUE';

      case 'none':
        return 'FALSE';

      case 'owner':
        return `(SELECT auth.uid()) = ${(rule as any).column}`;

      case 'role':
        // App role from app_metadata (server-controlled). The top-level `role`
        // claim is the Postgres role (anon/authenticated) in Supabase.
        return `((SELECT auth.jwt()) -> 'app_metadata' ->> 'role') = ${quoteLiteral((rule as any).role)}`;

      case 'belongs_to': {
        const r = rule as any;
        const signature = this.belongsToSignature(rule);
        const helper = this.policyHelperFnBySignature.get(signature);
        if (helper) {
          return `(SELECT ${helper}(${r.column}))`;
        }
        if (r.through) {
          let whereClause = `${r.through.localKey} = (SELECT auth.uid())`;
          if (r.through.where) {
            for (const [col, val] of Object.entries(r.through.where)) {
              if (Array.isArray(val)) {
                const quoted = (val as string[]).map((v: string) => quoteLiteral(v)).join(', ');
                whereClause += ` AND ${col} IN (${quoted})`;
              } else {
                whereClause += ` AND ${col} = ${quoteLiteral(val)}`;
              }
            }
          }
          return `${r.column} IN (SELECT ${r.through.foreignKey} FROM ${r.through.table} WHERE ${whereClause})`;
        }
        // Default: check via profiles table
        return `${r.column} IN (SELECT ${r.column} FROM profiles WHERE id = (SELECT auth.uid()))`;
      }

      case 'matches_field': {
        const r = rule as any;
        return `${wrapAuthCall(r.fieldA)} = ${wrapAuthCall(r.fieldB)}`;
      }

      case 'custom':
        return (rule as any).expression;

      case 'any': {
        const r = rule as any;
        const parts = r.rules.map((sub: PolicyRule) => this.ruleToSQL(sub));
        if (parts.length === 1) return parts[0];
        return parts.map((p: string) => `(${p})`).join('\n    OR ');
      }

      case 'all': {
        const r = rule as any;
        const parts = r.rules.map((sub: PolicyRule) => this.ruleToSQL(sub));
        if (parts.length === 1) return parts[0];
        return parts.map((p: string) => `(${p})`).join('\n    AND ');
      }

      case 'with_check':
        return this.ruleToSQL((rule as any).using);

      default:
        throw new Error(`[AccessNexus] Unknown policy rule kind: ${rule.kind}`);
    }
  }

  /**
   * SQL for the WITH CHECK clause of a rule (the row being written).
   * `policy.withCheck(using, check)` requires both, unless `mode: 'replace'`.
   */
  ruleToCheckSQL(rule: PolicyRule): string {
    switch (rule.kind) {
      case 'with_check': {
        const r = rule as import('../../core/types/policy.js').WithCheckRule;
        const checkExpr = this.ruleToCheckSQL(r.check);
        if (r.mode === 'replace') return checkExpr;
        return `(${this.ruleToCheckSQL(r.using)})\n    AND (${checkExpr})`;
      }
      case 'any': {
        const parts = (rule as any).rules.map((sub: PolicyRule) => this.ruleToCheckSQL(sub));
        if (parts.length === 1) return parts[0];
        return parts.map((p: string) => `(${p})`).join('\n    OR ');
      }
      case 'all': {
        const parts = (rule as any).rules.map((sub: PolicyRule) => this.ruleToCheckSQL(sub));
        if (parts.length === 1) return parts[0];
        return parts.map((p: string) => `(${p})`).join('\n    AND ');
      }
      default:
        return this.ruleToSQL(rule);
    }
  }

  // ---- Trigger Generation ----

  /** Trigger functions + triggers, one `<table>_triggers.sql` per table with `triggers`. */
  generateTriggers(schema: SchemaDef): GeneratedOutput[] {
    const outputs: GeneratedOutput[] = [];

    for (const [tableName, tableDef] of Object.entries(schema)) {
      if (!tableDef.triggers || tableDef.triggers.length === 0) continue;

      const sql = this.generateTableTriggers(tableName, tableDef);
      outputs.push({
        path: `${tableName}_triggers.sql`,
        content: sql,
      });
    }

    return outputs;
  }

  private generateTableTriggers(tableName: string, tableDef: TableDef): string {
    const { timestamps } = this.options;
    const lines: string[] = [];

    if (timestamps) {
      lines.push(`-- ============================================`);
      lines.push(`-- AccessNexus: Auto-generated triggers`);
      lines.push(`-- Table: ${tableName}`);
      if (!this.options.deterministic) {
        lines.push(`-- Generated at: ${new Date().toISOString()}`);
      }
      lines.push(`-- ============================================`);
      lines.push('');
    }

    for (const rule of tableDef.triggers!) {
      lines.push(this.triggerRuleToSQL(rule, tableName, tableDef));
      lines.push('');
    }

    return lines.join('\n');
  }

  /** Convert a TriggerRule to complete SQL (function + trigger) */
  triggerRuleToSQL(rule: TriggerRule, tableName: string, tableDef: TableDef): string {
    const { policyPrefix, idempotent } = this.options;
    const searchPath = this.functionSearchPathClause();

    switch (rule.kind) {
      case 'updated_at': {
        const r = rule as any;
        const fnName = `${policyPrefix}_${tableName}_updated_at_fn`;
        const trgName = `${policyPrefix}_${tableName}_updated_at`;

        return [
          `CREATE OR REPLACE FUNCTION ${fnName}()`,
          `RETURNS TRIGGER AS $$`,
          `BEGIN`,
          `  NEW.${r.column} = NOW();`,
          `  RETURN NEW;`,
          `END;`,
          `$$ LANGUAGE plpgsql`,
          `${searchPath};`,
          '',
          ...(idempotent ? [`DROP TRIGGER IF EXISTS ${trgName} ON ${tableName};`] : []),
          `CREATE TRIGGER ${trgName}`,
          `  BEFORE UPDATE ON ${tableName}`,
          `  FOR EACH ROW`,
          `  EXECUTE FUNCTION ${fnName}();`,
        ].join('\n');
      }

      case 'soft_delete': {
        const r = rule as any;
        const pk = singlePrimaryKey(tableDef) ?? 'id';
        const fnName = `${policyPrefix}_${tableName}_soft_delete_fn`;
        const trgName = `${policyPrefix}_${tableName}_soft_delete`;

        const guardFn = `${policyPrefix}_${tableName}_soft_delete_guard_fn`;
        const guardTrg = `${policyPrefix}_${tableName}_soft_delete_guard`;

        // SECURITY DEFINER: the DELETE policy already authorized this row; the
        // UPDATE that replaces the delete must not be re-judged by the UPDATE
        // policy (which would silently skip it or raise an RLS error).
        //
        // The guard stops API users (anon/authenticated) from setting or
        // clearing the column with a plain UPDATE — otherwise anyone the UPDATE
        // policy admits could soft-delete or restore rows the DELETE policy
        // forbids them to delete. The soft-delete function above runs as its
        // owner, so its own UPDATE passes; so do the service role and RPCs
        // declared with security: 'definer' (restore rows through those).
        return [
          `CREATE OR REPLACE FUNCTION ${fnName}()`,
          `RETURNS TRIGGER AS $$`,
          `BEGIN`,
          `  UPDATE ${this.qualifyTable(tableName)} SET ${r.column} = NOW() WHERE ${pk} = OLD.${pk};`,
          `  RETURN NULL;`,
          `END;`,
          `$$ LANGUAGE plpgsql`,
          `SECURITY DEFINER`,
          `${searchPath};`,
          '',
          ...(idempotent ? [`DROP TRIGGER IF EXISTS ${trgName} ON ${tableName};`] : []),
          `CREATE TRIGGER ${trgName}`,
          `  BEFORE DELETE ON ${tableName}`,
          `  FOR EACH ROW`,
          `  EXECUTE FUNCTION ${fnName}();`,
          '',
          `CREATE OR REPLACE FUNCTION ${guardFn}()`,
          `RETURNS TRIGGER AS $$`,
          `BEGIN`,
          `  IF NEW.${r.column} IS DISTINCT FROM OLD.${r.column} AND current_user IN ('anon', 'authenticated') THEN`,
          `    RAISE EXCEPTION '${tableName}.${r.column} can only be set by DELETE (soft delete)'`,
          `      USING ERRCODE = '42501',`,
          `      HINT = 'Delete the row instead; the DELETE policy decides who may. Restore rows with the service role or a security definer RPC.';`,
          `  END IF;`,
          `  RETURN NEW;`,
          `END;`,
          `$$ LANGUAGE plpgsql`,
          `${searchPath};`,
          '',
          ...(idempotent ? [`DROP TRIGGER IF EXISTS ${guardTrg} ON ${tableName};`] : []),
          `CREATE TRIGGER ${guardTrg}`,
          `  BEFORE UPDATE OF ${r.column} ON ${tableName}`,
          `  FOR EACH ROW`,
          `  EXECUTE FUNCTION ${guardFn}();`,
        ].join('\n');
      }

      case 'audit_log': {
        const r = rule as any;
        const fnName = `${policyPrefix}_${tableName}_audit_log_fn`;
        const trgName = `${policyPrefix}_${tableName}_audit_log`;

        // Build the data expression
        let oldExpr = 'TO_JSONB(OLD)';
        let newExpr = 'TO_JSONB(NEW)';
        if (r.columns && r.columns.length > 0) {
          const cols = (r.columns as string[]).map(c => `${quoteLiteral(c)}, OLD.${c}`).join(', ');
          oldExpr = `JSONB_BUILD_OBJECT(${cols})`;
          const newCols = (r.columns as string[]).map(c => `${quoteLiteral(c)}, NEW.${c}`).join(', ');
          newExpr = `JSONB_BUILD_OBJECT(${newCols})`;
        }

        // SECURITY DEFINER: API users write the audited table, but must not be
        // able to INSERT audit rows themselves (the audit table keeps
        // insert: policy.none()). The owner role (postgres on Supabase) has
        // BYPASSRLS, so the trigger's insert is not blocked by RLS.
        return [
          `CREATE OR REPLACE FUNCTION ${fnName}()`,
          `RETURNS TRIGGER AS $$`,
          `BEGIN`,
          `  INSERT INTO ${this.qualifyTable(r.table)} (table_name, operation, old_data, new_data, changed_at)`,
          `  VALUES (`,
          `    TG_TABLE_NAME,`,
          `    TG_OP,`,
          `    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE ${oldExpr} END,`,
          `    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE ${newExpr} END,`,
          `    NOW()`,
          `  );`,
          `  RETURN COALESCE(NEW, OLD);`,
          `END;`,
          `$$ LANGUAGE plpgsql`,
          `SECURITY DEFINER`,
          `${searchPath};`,
          '',
          ...(idempotent ? [`DROP TRIGGER IF EXISTS ${trgName} ON ${tableName};`] : []),
          `CREATE TRIGGER ${trgName}`,
          `  AFTER INSERT OR UPDATE OR DELETE ON ${tableName}`,
          `  FOR EACH ROW`,
          `  EXECUTE FUNCTION ${fnName}();`,
        ].join('\n');
      }

      case 'lock_columns': {
        const r = rule as any;
        const suffix = r.name ?? 'lock_columns';
        const fnName = `${policyPrefix}_${tableName}_${suffix}_fn`;
        const trgName = `${policyPrefix}_${tableName}_${suffix}`;
        // Columns kept current by trigger.updatedAt change on every UPDATE.
        const managed = (tableDef.triggers ?? [])
          .filter((t: any) => t.kind === 'updated_at')
          .map((t: any) => t.column as string);

        let changed: string;
        let label: string;
        if (Array.isArray(r.except)) {
          const free = [...new Set([...(r.except as string[]), ...managed])];
          const keys = `ARRAY[${free.map((c) => quoteLiteral(c)).join(', ')}]::text[]`;
          changed = `(to_jsonb(NEW) - ${keys}) IS DISTINCT FROM (to_jsonb(OLD) - ${keys})`;
          label = `only ${(r.except as string[]).join(', ')} can be changed`;
        } else {
          const locked = (r.columns as string[]).filter((c) => !managed.includes(c));
          changed = locked.map((c) => `NEW.${c} IS DISTINCT FROM OLD.${c}`).join(' OR ') || 'FALSE';
          label = `${locked.join(', ')} cannot be changed`;
        }

        // INVOKER: current_user is the API role for PostgREST requests and the
        // owner inside SECURITY DEFINER code, which is therefore never blocked.
        const condition = [
          `current_user IN ('anon', 'authenticated')`,
          ...(r.unless ? [`NOT COALESCE((${r.unless}), FALSE)`] : []),
          `(${changed})`,
        ].join('\n     AND ');

        return [
          `CREATE OR REPLACE FUNCTION ${fnName}()`,
          `RETURNS TRIGGER AS $$`,
          `BEGIN`,
          `  IF ${condition} THEN`,
          `    RAISE EXCEPTION ${quoteLiteral(`${tableName}: ${label}`)}`,
          `      USING ERRCODE = '42501';`,
          `  END IF;`,
          `  RETURN NEW;`,
          `END;`,
          `$$ LANGUAGE plpgsql`,
          `${searchPath};`,
          '',
          ...(idempotent ? [`DROP TRIGGER IF EXISTS ${trgName} ON ${tableName};`] : []),
          `CREATE TRIGGER ${trgName}`,
          `  BEFORE UPDATE ON ${tableName}`,
          `  FOR EACH ROW`,
          `  EXECUTE FUNCTION ${fnName}();`,
        ].join('\n');
      }

      case 'custom': {
        const r = rule as any;
        const fnName = `${policyPrefix}_${tableName}_${r.name}_fn`;
        const trgName = `${policyPrefix}_${tableName}_${r.name}`;
        const forEach = (r.forEach ?? 'row').toUpperCase();

        // Parse events into timing + event SQL
        const eventSQL = this.triggerEventsToSQL(r.events as TriggerEvent[]);

        const whenClause = r.when
          ? [`  WHEN (${r.when})`]
          : [];

        // A body with its own block (DECLARE ... / BEGIN ... END, as imported
        // from pg_proc.prosrc) is emitted as is; otherwise wrap it.
        const body = (r.functionBody as string).trim();
        const hasOwnBlock = /^(<<\w+>>\s*)?(DECLARE|BEGIN)\b/i.test(body);

        return [
          `CREATE OR REPLACE FUNCTION ${fnName}()`,
          `RETURNS TRIGGER AS $$`,
          ...(hasOwnBlock ? [body] : [`BEGIN`, `  ${body}`, `END;`]),
          `$$ LANGUAGE plpgsql`,
          ...(r.security === 'definer' ? [`SECURITY DEFINER`] : []),
          ...functionSetClauses(r.set, `trigger ${r.name}`),
          `${searchPath};`,
          '',
          ...(idempotent ? [`DROP TRIGGER IF EXISTS ${trgName} ON ${tableName};`] : []),
          `CREATE TRIGGER ${trgName}`,
          `  ${eventSQL} ON ${tableName}`,
          `  FOR EACH ${forEach}`,
          ...whenClause,
          `  EXECUTE FUNCTION ${fnName}();`,
        ].join('\n');
      }

      default:
        throw new Error(`[AccessNexus] Unknown trigger rule kind: ${rule.kind}`);
    }
  }

  /** Convert TriggerEvent[] to SQL timing clause */
  private triggerEventsToSQL(events: TriggerEvent[]): string {
    // Group by timing (BEFORE/AFTER)
    const grouped: Record<string, string[]> = {};
    for (const event of events) {
      const [timing, operation] = event.split('_') as [string, string];
      const timingUpper = timing.toUpperCase();
      if (!grouped[timingUpper]) grouped[timingUpper] = [];
      grouped[timingUpper].push(operation.toUpperCase());
    }

    // Generate SQL for each timing group
    const parts: string[] = [];
    for (const [timing, ops] of Object.entries(grouped)) {
      parts.push(`${timing} ${ops.join(' OR ')}`);
    }

    return parts.join(' OR ');
  }

  // ---- RPC Generation ----

  /** `rpcs.sql` with a function for every `rpc()` that has a `body`. */
  generateRpcs(schema: SchemaDef): GeneratedOutput[] {
    const rpcs = (schema as any).__rpcs as Record<string, RpcDef> | undefined;
    if (!rpcs || Object.keys(rpcs).length === 0) return [];

    const { timestamps } = this.options;
    const lines: string[] = [];

    if (timestamps) {
      lines.push(`-- ============================================`);
      lines.push(`-- AccessNexus: Auto-generated RPC functions`);
      if (!this.options.deterministic) {
        lines.push(`-- Generated at: ${new Date().toISOString()}`);
      }
      lines.push(`-- ============================================`);
      lines.push('');
    }

    for (const [name, def] of Object.entries(rpcs)) {
      // Only generate SQL for RPCs with a body
      if (!def.body) continue;

      const language = def.language ?? 'plpgsql';
      const security = (def.security ?? 'invoker').toUpperCase();
      const volatility = resolveRpcVolatility(name, def).toUpperCase();

      // Build argument list
      const argList = def.args
        ? Object.entries(def.args).map(([argName, arg]) => {
          const { type, default: dflt } = normalizeRpcArg(arg);
          return `${argName} ${this.columnTypeToPG(type)}${dflt !== undefined ? ` DEFAULT ${dflt}` : ''}`;
        }).join(', ')
        : '';

      // Build return type
      const returnsPG = def.returns
        ? this.columnTypeToPG(def.returns)
        : 'VOID';

      // Build function body
      const trimmedBody = def.body.trim();
      const hasOwnBlock = /^DECLARE\b/i.test(trimmedBody) || /^BEGIN\b/i.test(trimmedBody);
      const bodyContent = language === 'plpgsql' && !hasOwnBlock
        ? [`BEGIN`, `  ${trimmedBody}`, `END;`]
        : [trimmedBody];

      lines.push(`CREATE OR REPLACE FUNCTION ${name}(${argList})`);
      lines.push(`RETURNS ${returnsPG}`);
      lines.push(`LANGUAGE ${language}`);
      lines.push(`SECURITY ${security}`);
      lines.push(`${volatility}`);
      lines.push(this.functionSearchPathClause());
      lines.push(...functionSetClauses(def.set, `rpc ${name}`));
      lines.push(`AS $$`);
      lines.push(...bodyContent);
      lines.push(`$$;`);
      if (security === 'DEFINER') {
        // Supabase grants EXECUTE on new public functions to anon and
        // authenticated. A definer RPC bypasses RLS: keep it off anon unless
        // the schema says otherwise.
        const signature = `${name}(${Object.values(def.args ?? {}).map((a) => this.columnTypeToPG(normalizeRpcArg(a).type)).join(', ')})`;
        lines.push(`REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC${def.allowAnon ? '' : ', anon'};`);
        lines.push(`GRANT EXECUTE ON FUNCTION ${signature} TO authenticated, service_role${def.allowAnon ? ', anon' : ''};`);
      }
      lines.push('');
    }

    if (lines.length === 0 || lines.every(l => l.startsWith('--') || l === '')) {
      return [];
    }

    return [{ path: 'rpcs.sql', content: lines.join('\n') }];
  }

  // ---- Seed Generation ----

  /**
   * `seed.sql` with INSERTs for the given seed data. Users referenced through
   * `auth.users.id` foreign keys are provisioned in auth.users (email
   * confirmed) with `options.authPassword`, or a random unknowable password.
   */
  generateSeed(schema: SchemaDef, data: SeedDef, options: SeedSqlOptions = {}): GeneratedOutput[] {
    const { timestamps } = this.options;
    const lines: string[] = [];

    if (timestamps) {
      lines.push(`-- ============================================`);
      lines.push(`-- AccessNexus: Auto-generated seed data`);
      if (!this.options.deterministic) {
        lines.push(`-- Generated at: ${new Date().toISOString()}`);
      }
      lines.push(`-- ============================================`);
      lines.push('');
    }

    // Sort tables by dependencies to avoid FK errors during insertion
    const orderedTables = this.orderTablesByDependencies(schema);
    const tablesToSeed = orderedTables.filter((t) => data[t] && Array.isArray(data[t]) && data[t].length > 0);

    // Also include tables in data that might not be in the ordered list (e.g. circular deps or missing schema def)
    for (const tableName of Object.keys(data)) {
      if (!tablesToSeed.includes(tableName) && Array.isArray(data[tableName]) && data[tableName].length > 0) {
        tablesToSeed.push(tableName);
      }
    }

    // Auto-provision auth.users for tables that reference auth.users
    const authUserIds = this.collectAuthUserIds(schema, data, tablesToSeed);
    if (authUserIds.length > 0) {
      // A fixed, published password would create loginable accounts on any
      // database the seed reaches — default to a random one per user.
      const passwordExpr = options.authPassword
        ? this.formatSqlValue(options.authPassword)
        : `encode(gen_random_bytes(24), 'base64')`;
      lines.push(`-- Auto-provision auth.users for FK references`);
      for (const entry of authUserIds) {
        lines.push(
          `INSERT INTO auth.users (id, instance_id, email, encrypted_password, aud, role, created_at, updated_at, confirmation_token, email_confirmed_at)`
          + ` VALUES (${this.formatSqlValue(entry.id)}, '00000000-0000-0000-0000-000000000000', ${this.formatSqlValue(entry.email)}, crypt(${passwordExpr}, gen_salt('bf')), 'authenticated', 'authenticated', NOW(), NOW(), '', NOW())`
          + ` ON CONFLICT (id) DO NOTHING;`
        );
      }
      lines.push('');
    }

    for (const tableName of tablesToSeed) {
      const rows = data[tableName];
      if (!rows || rows.length === 0) continue;

      lines.push(`-- Seed data for: ${tableName}`);
      
      // Get PK for ON CONFLICT
      // If no PK defined in schema (unlikely for Supabase), fallback to 'id'
      const pkCols = schema[tableName] ? primaryKeyColumns(schema[tableName]) : [];
      if (pkCols.length === 0) pkCols.push('id');

      for (const row of rows) {
        const keys = Object.keys(row);
        if (keys.length === 0) continue;

        const columns = keys.map((k) => `"${k}"`).join(', ');
        const values = keys.map((k) => this.formatSqlValue(row[k])).join(', ');
        
        // Generate DO UPDATE SET clause for non-PK columns
        const updateAssignments = keys
          .filter((k) => !pkCols.includes(k))
          .map((k) => `"${k}" = EXCLUDED."${k}"`);

        const conflictAction = updateAssignments.length > 0
          ? `DO UPDATE SET ${updateAssignments.join(', ')}`
          : `DO NOTHING`;

        lines.push(
          `INSERT INTO "${tableName}" (${columns}) VALUES (${values}) ON CONFLICT (${pkCols.map((c) => `"${c}"`).join(', ')}) ${conflictAction};`
        );
      }
      lines.push('');
    }

    return [{ path: 'seed.sql', content: lines.join('\n') }];
  }

  private formatSqlValue(value: unknown): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    
    // JSON arrays/objects
    if (typeof value === 'object') {
       return `'${JSON.stringify(value).replaceAll("'", "''")}'`;
    }
    
    // Strings
    return `'${String(value).replaceAll("'", "''")}'`;
  }

  /**
   * Collect UUIDs that need to exist in auth.users before seeding.
   * Detects columns that reference auth.users and extracts their values from seed data.
   */
  private collectAuthUserIds(
    schema: SchemaDef,
    data: SeedDef,
    tablesToSeed: string[],
  ): Array<{ id: string; email: string | null }> {
    const seen = new Set<string>();
    const entries: Array<{ id: string; email: string | null }> = [];

    for (const tableName of tablesToSeed) {
      const tableDef = schema[tableName];
      if (!tableDef?.references) continue;

      for (const [column, ref] of Object.entries(tableDef.references)) {
        if (!ref) continue;
        // Match auth.users.id references
        const isAuthRef = ref === 'auth.users.id';
        if (!isAuthRef) continue;

        const rows = data[tableName];
        if (!rows) continue;

        for (const row of rows) {
          const val = row[column];
          if (val && typeof val === 'string' && !seen.has(val)) {
            seen.add(val);
            // Try to find an email column in the same row for a better auth.users entry
            const email = (row.email as string) ?? null;
            entries.push({ id: val, email });
          }
        }
      }
    }

    return entries;
  }

  /** Map ColumnType to PostgreSQL type name */
  private columnTypeToPG(type: string): string {
    const base = type.endsWith('?') ? type.slice(0, -1) : type;

    const map: Record<string, string> = {
      uuid: 'UUID',
      text: 'TEXT',
      varchar: 'VARCHAR',
      int: 'INTEGER',
      smallint: 'SMALLINT',
      bigint: 'BIGINT',
      serial: 'SERIAL',
      float: 'DOUBLE PRECISION',
      decimal: 'NUMERIC',
      boolean: 'BOOLEAN',
      json: 'JSON',
      jsonb: 'JSONB',
      date: 'DATE',
      timestamp: 'TIMESTAMP',
      timestamptz: 'TIMESTAMPTZ',
      time: 'TIME',
      'text[]': 'TEXT[]',
      'int[]': 'INTEGER[]',
      'uuid[]': 'UUID[]',
      void: 'VOID',
    };

    if (base.startsWith('enum(')) {
      return base;
    }

    return map[base] ?? base.toUpperCase();
  }

  private parseReferenceTarget(reference: string): { table: string; column: string; external: boolean } {
    const parts = reference.split('.');
    if (parts.length === 2) {
      return { table: parts[0], column: parts[1], external: false };
    }
    if (parts.length === 3) {
      return { table: parts[1], column: parts[2], external: true };
    }
    return { table: '', column: '', external: true };
  }

  private relationAliasFromColumn(column: string): string {
    return column.endsWith('_id') ? column.slice(0, -3) : column;
  }

  private getTableRelations(
    schema: SchemaDef,
    tableName: string,
  ): Array<{ alias: string; sourceColumn: string; targetTable: string; targetColumn: string; constraint: string }> {
    const references = schema[tableName]?.references;
    if (!references) return [];

    const usedAliases = new Set<string>();
    const relations: Array<{ alias: string; sourceColumn: string; targetTable: string; targetColumn: string; constraint: string }> = [];

    for (const [sourceColumn, reference] of Object.entries(references)) {
      if (!reference) continue;

      const parsed = this.parseReferenceTarget(reference);
      if (!parsed.table || !parsed.column || parsed.external) continue;
      if (!(parsed.table in schema)) continue;

      let alias = this.relationAliasFromColumn(sourceColumn);
      if (!alias) alias = sourceColumn;
      if (usedAliases.has(alias)) {
        alias = `${alias}_${sourceColumn}`;
      }
      let suffix = 2;
      while (usedAliases.has(alias)) {
        alias = `${alias}_${suffix}`;
        suffix += 1;
      }
      usedAliases.add(alias);

      relations.push({
        alias,
        sourceColumn,
        targetTable: parsed.table,
        targetColumn: parsed.column,
        constraint: `${tableName}_${sourceColumn}_fkey`,
      });
    }

    return relations;
  }

  // ---- Database Mode Client Generation ----

  /**
   * Generate client code that uses the Supabase Database type directly.
   * No separate types.ts is generated — types come from database.types.ts.
   */
  private generateDatabaseModeClient(schema: SchemaDef): GeneratedOutput[] {
    const dbTypesPath = this.options.databaseTypes ?? './database.types';
    const tableNames = Object.keys(schema);
    const rpcs = (schema as any).__rpcs as Record<string, RpcDef> | undefined;
    const rpcNames = rpcs ? Object.keys(rpcs) : [];

    const lines: string[] = [
      '// ============================================',
      '// AccessNexus: Auto-generated typed client',
      '// Uses your Supabase Database types directly',
      '// DO NOT EDIT — regenerate with `npx accessnexus generate`',
      '// ============================================',
      '',
      `import type { Database } from '${dbTypesPath}';`,
      '',
      `type Tables = Database['public']['Tables'];`,
      `type Functions = Database['public']['Functions'];`,
      `type TableName = keyof Tables & string;`,
      `type FunctionName = keyof Functions & string;`,
      `type RowOf<T extends TableName> = Tables[T]['Row'];`,
      `type InsertOf<T extends TableName> = Tables[T]['Insert'];`,
      `type UpdateOf<T extends TableName> = Tables[T]['Update'];`,
      `type QueryResult<T> = Promise<{ data: T | null; error: unknown }>;`,
      '',
      `interface SelectQuery<T extends TableName> {`,
      `  match(filter: Partial<RowOf<T>>): QueryResult<RowOf<T>[]>;`,
      `  eq(column: string, value: unknown): SelectQuery<T>;`,
      `  is(column: string, value: null): SelectQuery<T>;`,
      `  single(): QueryResult<RowOf<T>>;`,
      `}`,
      '',
      `interface MutationQuery<T extends TableName> {`,
      `  eq(column: string, value: unknown): MutationQuery<T>;`,
      `  select(): SelectQuery<T>;`,
      `}`,
      '',
      `interface DeleteQuery<T extends TableName> {`,
      `  eq(column: string, value: unknown): QueryResult<RowOf<T>[]>;`,
      `}`,
      '',
      `interface TableQuery<T extends TableName> {`,
      `  select(columns: string): SelectQuery<T>;`,
      `  insert(data: InsertOf<T>): MutationQuery<T>;`,
      `  update(data: UpdateOf<T>): MutationQuery<T>;`,
      `  delete(): DeleteQuery<T>;`,
      `}`,
      '',
      `type AccessNexusTransport = {`,
      `  auth: unknown;`,
      `  from<T extends TableName>(table: T): TableQuery<T>;`,
      `  rpc<F extends FunctionName>(name: F, args: Functions[F]['Args']): QueryResult<Functions[F]['Returns']>;`,
      `};`,
      '',
      `// Loose shape a real Supabase client satisfies (its builders are thenables,`,
      `// not Promises, so it cannot match AccessNexusTransport structurally).`,
      `type AccessNexusProvider = {`,
      `  auth: unknown;`,
      `  from(table: string): unknown;`,
      `  rpc(name: string, args?: object): unknown;`,
      `};`,
      '',
      `function buildSelectClause(`,
      `  base: string,`,
      `  joins: Record<string, string>,`,
      `  include?: Record<string, true | undefined>,`,
      `): string {`,
      `  if (!include) return base;`,
      `  const selected = Object.keys(include)`,
      `    .filter((key) => include[key] === true && joins[key])`,
      `    .map((key) => joins[key]);`,
      `  if (selected.length === 0) return base;`,
      `  return \`\${base}, \${selected.join(', ')}\`;`,
      `}`,
    ];
    lines.push('');

    for (const tableName of tableNames) {
      const relations = this.getTableRelations(schema, tableName);
      if (relations.length === 0) continue;

      const relTypeName = `${this.toPascalCase(tableName)}Relations`;
      const includeTypeName = `${this.toPascalCase(tableName)}Include`;
      const withIncludeTypeName = `${this.toPascalCase(tableName)}WithInclude`;
      const joinConstName = `${tableName}Joins`;

      lines.push(`type ${relTypeName} = {`);
      for (const relation of relations) {
        lines.push(`  '${relation.alias}': RowOf<'${relation.targetTable}'>;`);
      }
      lines.push(`};`);
      lines.push(`type ${includeTypeName} = Partial<Record<keyof ${relTypeName}, true>>;`);
      lines.push(`type ${withIncludeTypeName}<TInclude extends ${includeTypeName} | undefined> =`);
      lines.push(`  RowOf<'${tableName}'>`);
      for (const relation of relations) {
        lines.push(`  & (TInclude extends { '${relation.alias}': true } ? { '${relation.alias}': ${relTypeName}['${relation.alias}'] | null } : unknown)`);
      }
      lines.push(`;`);
      lines.push(`const ${joinConstName}: Record<keyof ${relTypeName} & string, string> = {`);
      for (const relation of relations) {
        lines.push(`  '${relation.alias}': '${relation.alias}:${relation.targetTable}!${relation.constraint}(*)',`);
      }
      lines.push(`};`);
      lines.push('');
    }

    // Client factory
    lines.push(`export function createAccessNexusClient<TClient extends AccessNexusProvider>(providerRaw: TClient) {`);
    lines.push(`  // Accept a real Supabase client (loose AccessNexusProvider) and use the strict`);
    lines.push(`  // AccessNexusTransport shape internally for the typed accessors below.`);
    lines.push(`  const provider = providerRaw as unknown as AccessNexusTransport;`);
    lines.push(`  return {`);
    lines.push(`    auth: providerRaw.auth,`);
    lines.push('');

    for (const tableName of tableNames) {
      const tableDef = schema[tableName];
      const pk = singlePrimaryKey(tableDef) ?? 'id';
      const softDeleteColumn = tableDef.softDelete;
      const relations = this.getTableRelations(schema, tableName);
      const includeTypeName = `${this.toPascalCase(tableName)}Include`;
      const withIncludeTypeName = `${this.toPascalCase(tableName)}WithInclude`;
      const joinConstName = `${tableName}Joins`;

      lines.push(`    ${tableName}: {`);
      if (relations.length > 0) {
        lines.push(`      findMany: <TInclude extends ${includeTypeName} | undefined = undefined>(`);
        lines.push(`        filter?: Partial<RowOf<'${tableName}'>>,`);
        lines.push(`        options?: { include?: TInclude },`);
        lines.push(`      ) => {`);
        lines.push(`        const select = buildSelectClause('*', ${joinConstName}, options?.include as Record<string, true | undefined> | undefined);`);
        if (softDeleteColumn) {
          lines.push(`        return provider.from('${tableName}').select(select).is('${softDeleteColumn}', null).match(filter ?? {}) as QueryResult<${withIncludeTypeName}<TInclude>[]>;`);
        } else {
          lines.push(`        return provider.from('${tableName}').select(select).match(filter ?? {}) as QueryResult<${withIncludeTypeName}<TInclude>[]>;`);
        }
        lines.push(`      },`);
      } else {
        lines.push(`      findMany: (filter?: Partial<RowOf<'${tableName}'>>) =>`);
        if (softDeleteColumn) {
          lines.push(`        provider.from('${tableName}').select('*').is('${softDeleteColumn}', null).match(filter ?? {}),`);
        } else {
          lines.push(`        provider.from('${tableName}').select('*').match(filter ?? {}),`);
        }
      }
      lines.push('');
      if (relations.length > 0) {
        lines.push(`      findById: <TInclude extends ${includeTypeName} | undefined = undefined>(`);
        lines.push(`        id: string,`);
        lines.push(`        options?: { include?: TInclude },`);
        lines.push(`      ) => {`);
        lines.push(`        const select = buildSelectClause('*', ${joinConstName}, options?.include as Record<string, true | undefined> | undefined);`);
        if (softDeleteColumn) {
          lines.push(`        return provider.from('${tableName}').select(select).eq('${pk}', id).is('${softDeleteColumn}', null).single() as QueryResult<${withIncludeTypeName}<TInclude>>;`);
        } else {
          lines.push(`        return provider.from('${tableName}').select(select).eq('${pk}', id).single() as QueryResult<${withIncludeTypeName}<TInclude>>;`);
        }
        lines.push(`      },`);
      } else {
        lines.push(`      findById: (id: string) =>`);
        if (softDeleteColumn) {
          lines.push(`        provider.from('${tableName}').select('*').eq('${pk}', id).is('${softDeleteColumn}', null).single(),`);
        } else {
          lines.push(`        provider.from('${tableName}').select('*').eq('${pk}', id).single(),`);
        }
      }
      lines.push('');
      lines.push(`      create: (data: Tables['${tableName}']['Insert']) =>`);
      lines.push(`        provider.from('${tableName}').insert(data).select().single(),`);
      lines.push('');
      lines.push(`      update: (id: string, data: Tables['${tableName}']['Update']) =>`);
      lines.push(`        provider.from('${tableName}').update(data).eq('${pk}', id).select().single(),`);
      lines.push('');
      lines.push(`      delete: (id: string) =>`);
      // On softDelete tables the BEFORE DELETE trigger turns this into
      // SET <column> = NOW(), so the DELETE policy (not UPDATE) decides it.
      lines.push(`        provider.from('${tableName}').delete().eq('${pk}', id),`);
      lines.push(`    },`);
      lines.push('');
    }

    // RPC namespace (Database mode — types from Functions)
    if (rpcNames.length > 0) {
      lines.push(`    rpc: {`);
      for (const name of rpcNames) {
        lines.push(`      ${name}: (args: Functions['${name}']['Args']) =>`);
        lines.push(`        provider.rpc('${name}', args),`);
        lines.push('');
      }
      lines.push(`    },`);
      lines.push('');
    }

    lines.push(`  };`);
    lines.push(`}`);
    lines.push('');
    lines.push(`export type AccessNexusClient = ReturnType<typeof createAccessNexusClient>;`);

    return [
      { path: 'client.ts', content: lines.join('\n') },
    ];
  }

  // ---- TypeScript Generation (manual mode) ----

  private columnTypeToTS(colType: string): string {
    const base = colType.endsWith('?') ? colType.slice(0, -1) : colType;
    const nullable = colType.endsWith('?');

    const map: Record<string, string> = {
      uuid: 'string',
      text: 'string',
      varchar: 'string',
      int: 'number',
      smallint: 'number',
      bigint: 'number',
      serial: 'number',
      float: 'number',
      decimal: 'number',
      numeric: 'number',
      boolean: 'boolean',
      json: 'Record<string, unknown>',
      jsonb: 'Record<string, unknown>',
      date: 'string',
      timestamp: 'string',
      timestamptz: 'string',
      time: 'string',
      'text[]': 'string[]',
      'int[]': 'number[]',
      'uuid[]': 'string[]',
    };

    let tsType = map[base] ?? (base.startsWith('numeric(') ? 'number' : 'unknown');
    if (base.startsWith('enum(')) {
      tsType = this.enumToTsUnion(base) ?? 'string';
    }
    return nullable ? `${tsType} | null` : tsType;
  }

  private generateCreateTableSQL(tableName: string, tableDef: TableDef): string {
    const lines: string[] = [];
    const pkCols = primaryKeyColumns(tableDef);
    const primaryKey = pkCols.length === 1 ? pkCols[0] : undefined;
    const tableLevelRefs = tableDef.references as Record<string, string> | undefined;

    for (const [columnName, rawColumnDef] of Object.entries(tableDef.columns)) {
      const col = normalizeColumn(rawColumnDef);
      const colType = baseType(col.type);
      const colParts: string[] = [];
      const isPk = primaryKey === columnName;

      colParts.push(`  ${columnName}`);
      if (colType.startsWith('enum(')) {
        colParts.push(this.enumTypeName(tableName, columnName));
      } else {
        colParts.push(this.columnTypeToPG(colType));
      }

      if (!isNullable(col.type) && !isPk) {
        colParts.push('NOT NULL');
      }
      if (isPk && colType === 'bigint' && col.default === undefined) {
        colParts.push('GENERATED ALWAYS AS IDENTITY');
      }
      if (isPk && colType === 'uuid' && col.default === undefined) {
        const uuidFn = this.uuidDefaultExpression;
        colParts.push(`DEFAULT ${uuidFn}`);
      }
      if (col.default !== undefined) {
        colParts.push(`DEFAULT ${col.default}`);
      }
      if (col.unique) {
        colParts.push('UNIQUE');
      }
      if (col.check) {
        colParts.push(`CHECK (${col.check})`);
      }

      const ref = col.references ?? tableLevelRefs?.[columnName];
      if (ref) {
        const fk = this.parseReference(ref);
        const onDelete = col.onDelete ?? tableDef.onDelete?.[columnName];
        colParts.push(`REFERENCES ${fk.tablePath}(${fk.column})${onDelete ? ` ON DELETE ${onDelete.toUpperCase()}` : ''}`);
      }

      if (isPk) {
        colParts.push('PRIMARY KEY');
      }

      lines.push(colParts.join(' '));
    }

    if (pkCols.length > 1) {
      lines.push(`  PRIMARY KEY (${pkCols.join(', ')})`);
    }

    return [
      `CREATE TABLE IF NOT EXISTS ${tableName} (`,
      lines.join(',\n'),
      `);`,
    ].join('\n');
  }

  private generateIndexesSQL(tableName: string, tableDef: TableDef): string[] {
    const explicit = tableDef.indexes ?? [];
    const fkColumns = this.collectForeignKeyColumns(tableDef);
    const policyColumns = this.collectPolicyColumns(tableDef);
    const singlePk = singlePrimaryKey(tableDef);
    const hasSoftDelete = Boolean(tableDef.softDelete && singlePk);
    if (explicit.length === 0 && fkColumns.length === 0 && policyColumns.length === 0 && !hasSoftDelete) return [];

    const output: string[] = [];
    const seenSignatures = new Set<string>();

    explicit.forEach((index, idx) => {
      const unique = index.unique ? 'UNIQUE ' : '';
      const indexName = index.name ?? `idx_${tableName}_${index.columns.join('_')}_${idx + 1}`;
      const signature = `${index.unique ? 'u' : 'n'}|${index.columns.join(',')}`;
      seenSignatures.add(signature);
      output.push(`CREATE ${unique}INDEX IF NOT EXISTS ${indexName} ON ${tableName}(${index.columns.join(', ')});`);
    });

    for (const fkColumn of fkColumns) {
      const signature = `n|${fkColumn}`;
      if (seenSignatures.has(signature)) continue;
      // The primary key / a UNIQUE column already has an index.
      if (fkColumn === singlePk || normalizeColumn(tableDef.columns[fkColumn] ?? 'text').unique) continue;
      seenSignatures.add(signature);
      output.push(`CREATE INDEX IF NOT EXISTS idx_${tableName}_${fkColumn}_fk ON ${tableName}(${fkColumn});`);
    }

    // Auto-index columns referenced in RLS policies (isOwner, belongsTo, matchesField)
    for (const col of policyColumns) {
      if (col === singlePk) continue;
      const signature = `n|${col}`;
      if (seenSignatures.has(signature)) continue;
      seenSignatures.add(signature);
      output.push(`CREATE INDEX IF NOT EXISTS idx_${tableName}_${col}_rls ON ${tableName}(${col});`);
    }

    if (tableDef.softDelete && singlePk) {
      output.push(
        `CREATE INDEX IF NOT EXISTS idx_${tableName}_active_pk ON ${tableName}(${singlePk}) WHERE ${tableDef.softDelete} IS NULL;`,
      );
    }

    return output;
  }

  private createEnumSQL(enumName: string, enumType: string): string {
    const values = this.parseEnumValues(enumType).map((value) => `'${this.escapeSqlString(value)}'`);
    return [
      `DO $$`,
      `BEGIN`,
      `  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = '${this.escapeSqlString(enumName)}') THEN`,
      `    CREATE TYPE ${enumName} AS ENUM (${values.join(', ')});`,
      `  END IF;`,
      `END $$;`,
    ].join('\n');
  }

  private enumTypeName(tableName: string, columnName: string): string {
    return `${tableName}_${columnName}_enum`;
  }

  private parseEnumValues(enumType: string): string[] {
    const match = enumType.match(/^enum\((.*)\)$/);
    if (!match) return [];

    return match[1]
      .split(',')
      .map((item) => item.trim())
      .map((item) => item.replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }

  private enumToTsUnion(enumType: string): string | null {
    const values = this.parseEnumValues(enumType);
    if (values.length === 0) return null;
    return values.map((value) => `'${value.replaceAll("'", "\\'")}'`).join(' | ');
  }

  private escapeSqlString(value: string): string {
    return value.replaceAll("'", "''");
  }

  private parseReference(reference: string): { tablePath: string; column: string } {
    const parts = reference.split('.');
    if (parts.length === 2) {
      return { tablePath: parts[0], column: parts[1] };
    }

    if (parts.length === 3) {
      return { tablePath: `${parts[0]}.${parts[1]}`, column: parts[2] };
    }

    throw new Error(`[AccessNexus] Invalid reference "${reference}"`);
  }

  private orderTablesByDependencies(schema: SchemaDef): string[] {
    const tableNames = Object.keys(schema);
    const tableSet = new Set(tableNames);
    const deps = new Map<string, Set<string>>();

    for (const tableName of tableNames) {
      deps.set(tableName, new Set<string>());
      const tableDef = schema[tableName];

      if (tableDef.references) {
        for (const ref of Object.values(tableDef.references)) {
          if (!ref) continue;
          const parts = ref.split('.');
          const refTable = parts.length === 3 ? parts[1] : parts[0];
          const isExternal = parts.length === 3;
          if (!isExternal && tableSet.has(refTable)) {
            deps.get(tableName)!.add(refTable);
          }
        }
      }

      for (const rawColumnDef of Object.values(tableDef.columns)) {
        const col = normalizeColumn(rawColumnDef);
        if (!col.references) continue;
        const parts = col.references.split('.');
        const refTable = parts.length === 3 ? parts[1] : parts[0];
        const isExternal = parts.length === 3;
        if (!isExternal && tableSet.has(refTable)) {
          deps.get(tableName)!.add(refTable);
        }
      }
    }

    const sorted: string[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (table: string) => {
      if (visited.has(table)) return;
      if (visiting.has(table)) return; // cyclic dependency: keep deterministic fallback order

      visiting.add(table);
      for (const dep of deps.get(table) ?? []) {
        visit(dep);
      }
      visiting.delete(table);
      visited.add(table);
      sorted.push(table);
    };

    for (const tableName of tableNames) {
      visit(tableName);
    }

    return sorted;
  }

  private collectForeignKeyColumns(tableDef: TableDef): string[] {
    const columns = new Set<string>();

    if (tableDef.references) {
      for (const key of Object.keys(tableDef.references)) {
        columns.add(key);
      }
    }

    for (const [columnName, raw] of Object.entries(tableDef.columns)) {
      const col = normalizeColumn(raw);
      if (col.references) {
        columns.add(columnName);
      }
    }

    return [...columns];
  }

  private collectPolicyHelpers(
    tableName: string,
    tableDef: TableDef,
    operations: readonly PolicyOperation[],
  ): string[] {
    const helpers: Array<{ fnName: string; rule: any; anon: boolean }> = [];
    let helperCount = 0;

    for (const op of operations) {
      const rule = tableDef.policies?.[op];
      if (!rule) continue;
      // A policy granted TO public is also evaluated for anon, which then needs EXECUTE.
      const anon = this.policyRoleFor(op, rule) === 'public';

      const belongsToRules = this.collectBelongsToRules(rule);
      for (const belongsToRule of belongsToRules) {
        const signature = this.belongsToSignature(belongsToRule);
        const existing = this.policyHelperFnBySignature.get(signature);
        if (existing) {
          const helper = helpers.find((h) => h.fnName === existing);
          if (helper && anon) helper.anon = true;
          continue;
        }

        helperCount++;
        const fnName = `${this.options.policyPrefix}_${tableName}_belongs_to_${helperCount}_fn`;
        this.policyHelperFnBySignature.set(signature, fnName);
        helpers.push({ fnName, rule: belongsToRule, anon });
      }
    }

    return helpers.map(({ fnName, rule, anon }) => [
      this.belongsToRuleToHelperSQL(fnName, rule),
      // SECURITY DEFINER helpers are callable through /rest/v1/rpc unless
      // EXECUTE is restricted to the roles whose policies use them.
      `REVOKE EXECUTE ON FUNCTION ${fnName}(uuid) FROM PUBLIC${anon ? '' : ', anon'};`,
      `GRANT EXECUTE ON FUNCTION ${fnName}(uuid) TO authenticated${anon ? ', anon' : ''};`,
    ].join('\n'));
  }

  private collectBelongsToRules(rule: PolicyRule): PolicyRule[] {
    if (rule.kind === 'belongs_to') return [rule];
    if (rule.kind === 'any' || rule.kind === 'all') {
      const nested = (rule as any).rules as PolicyRule[];
      return nested.flatMap((r) => this.collectBelongsToRules(r));
    }
    if (rule.kind === 'with_check') {
      const wc = rule as any;
      return [
        ...this.collectBelongsToRules(wc.using),
        ...this.collectBelongsToRules(wc.check),
      ];
    }
    return [];
  }

  /**
   * Collect all column names referenced in RLS policy rules.
   * Used to auto-generate indexes for columns that appear in
   * USING/WITH CHECK expressions (isOwner, belongsTo, matchesField).
   */
  private collectPolicyColumns(tableDef: TableDef): string[] {
    const cols = new Set<string>();
    const walk = (rule: PolicyRule) => {
      switch (rule.kind) {
        case 'owner':
          cols.add((rule as any).column);
          break;
        case 'belongs_to':
          cols.add((rule as any).column);
          break;
        case 'matches_field':
          if (isColumnName((rule as any).fieldA)) cols.add((rule as any).fieldA);
          if (isColumnName((rule as any).fieldB)) cols.add((rule as any).fieldB);
          break;
        case 'any':
        case 'all':
          (rule as any).rules.forEach(walk);
          break;
        case 'with_check':
          walk((rule as any).using);
          walk((rule as any).check);
          break;
      }
    };
    for (const op of ['select', 'insert', 'update', 'delete'] as const) {
      const rule = tableDef.policies?.[op];
      if (rule) walk(rule);
    }
    return [...cols];
  }

  private belongsToSignature(rule: PolicyRule): string {
    const r = rule as any;
    const through = r.through
      ? `${r.through.table}|${r.through.foreignKey}|${r.through.localKey}`
      : '';
    const where = r.through?.where ? `|${JSON.stringify(r.through.where)}` : '';
    return `${r.column}|${through}${where}`;
  }

  private belongsToRuleToHelperSQL(fnName: string, rule: any): string {
    const qualifyTable = (table: string) =>
      table.includes('.') ? table : `${this.options.schemaName}.${table}`;

    let predicate: string;
    if (rule.through) {
      let whereClause = `${rule.through.foreignKey} = p_value AND ${rule.through.localKey} = (SELECT auth.uid())`;
      if (rule.through.where) {
        for (const [col, val] of Object.entries(rule.through.where)) {
          if (Array.isArray(val)) {
            const quoted = (val as string[]).map((v: string) => quoteLiteral(v)).join(', ');
            whereClause += ` AND ${col} IN (${quoted})`;
          } else {
            whereClause += ` AND ${col} = ${quoteLiteral(val)}`;
          }
        }
      }
      predicate = `SELECT EXISTS (SELECT 1 FROM ${qualifyTable(rule.through.table)} WHERE ${whereClause})`;
    } else {
      predicate = `SELECT EXISTS (SELECT 1 FROM ${qualifyTable('profiles')} WHERE ${rule.column} = p_value AND id = (SELECT auth.uid()))`;
    }

    return [
      `CREATE OR REPLACE FUNCTION ${fnName}(p_value uuid)`,
      `RETURNS boolean`,
      `LANGUAGE sql`,
      `SECURITY DEFINER`,
      this.functionSearchPathClause(),
      `AS $$`,
      `  ${predicate};`,
      `$$;`,
    ].join('\n');
  }

  /** `schema.table` unless the name is already qualified. */
  private qualifyTable(table: string): string {
    return table.includes('.') ? table : `${this.options.schemaName}.${table}`;
  }

  private functionSearchPathClause(): string {
    return `SET search_path = pg_catalog, ${this.options.schemaName}`;
  }

  /** UUID strategy for primary keys without a default (`'v4'` or `'v7'`). */
  get uuidGeneration(): 'v4' | 'v7' {
    return this.options.uuidGeneration;
  }

  /** Default expression for a uuid primary key without an explicit default. */
  get uuidDefaultExpression(): string {
    return this.options.uuidGeneration === 'v7' ? `${this.options.schemaName}.accessnexus_uuidv7()` : 'gen_random_uuid()';
  }

  /**
   * Does any table whose uuid PK defaults to `accessnexus_uuidv7()` let anon
   * insert? The column default runs as the inserting role, so `anon` then
   * needs EXECUTE on the function; otherwise it is revoked from anon.
   */
  uuidv7NeedsAnon(schema: SchemaDef, tables: readonly string[] = Object.keys(schema)): boolean {
    return tables.some((t) => {
      const def = schema[t];
      if (!def?.columns || !def.primaryKey || !def.columns[def.primaryKey]) return false;
      const col = normalizeColumn(def.columns[def.primaryKey]);
      if (baseType(col.type) !== 'uuid' || col.default !== undefined) return false;
      const insert = def.policies?.insert;
      return insert ? this.anonMayWrite(insert) : false;
    });
  }

  /**
   * PL/pgSQL function that creates RFC 9562 UUIDv7 values: a 48-bit Unix
   * millisecond timestamp, version nibble 7, variant 10, random tail.
   * Time-ordered UUIDs avoid B-tree index fragmentation on large tables.
   *
   * It lives in the exposed schema (column defaults call it), so EXECUTE is
   * revoked from PUBLIC and anon (PostgREST would otherwise expose it as an
   * RPC) and granted to the roles that insert rows. `grantAnon` re-grants it
   * to anon when a v7 table accepts anonymous inserts.
   */
  uuidv7FunctionSQL(grantAnon = false): string {
    const fn = `${this.options.schemaName}.accessnexus_uuidv7()`;
    return [
      `CREATE OR REPLACE FUNCTION ${fn}`,
      `RETURNS uuid`,
      `LANGUAGE plpgsql`,
      `VOLATILE`,
      `${this.functionSearchPathClause()}`,
      `AS $$`,
      `DECLARE`,
      `  unix_ts_ms bytea;`,
      `  uuid_bytes bytea;`,
      `BEGIN`,
      `  unix_ts_ms = substring(int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint) from 3);`,
      `  uuid_bytes = uuid_send(gen_random_uuid());`,
      `  uuid_bytes = overlay(uuid_bytes placing unix_ts_ms from 1 for 6);`,
      `  uuid_bytes = set_byte(uuid_bytes, 6, (get_byte(uuid_bytes, 6) & 15) | 112);`,
      `  uuid_bytes = set_byte(uuid_bytes, 8, (get_byte(uuid_bytes, 8) & 63) | 128);`,
      `  RETURN encode(uuid_bytes, 'hex')::uuid;`,
      `END`,
      `$$;`,
      `REVOKE EXECUTE ON FUNCTION ${fn} FROM PUBLIC, anon;`,
      `GRANT EXECUTE ON FUNCTION ${fn} TO ${grantAnon ? 'anon, ' : ''}authenticated, service_role;`,
    ].join('\n');
  }

  /**
   * Postgres role a policy is granted `TO`. The predicate always decides; the
   * role is defense in depth, so it is `authenticated` unless anonymous
   * visitors are meant to pass:
   * - `select`: `public` when some branch can be true without a signed-in user
   *   (`policy.public()`, `policy.custom(...)`, a column-to-column
   *   `matchesField`), so `any([custom('published'), isOwner(...)])` really is
   *   readable by anon;
   * - writes: `public` only when an explicit `policy.public()` decides it.
   */
  private policyRoleFor(op: PolicyOperation, rule: PolicyRule): 'public' | 'authenticated' {
    const anon = op === 'select' ? this.anonMayRead(rule) : this.anonMayWrite(rule);
    return anon ? 'public' : 'authenticated';
  }

  /** Can this rule (as a USING clause) be true for a request without a user? */
  private anonMayRead(rule: PolicyRule): boolean {
    switch (rule.kind) {
      case 'public':
      case 'custom':
        return true;
      case 'matches_field': {
        const r = rule as any;
        return !/\bauth\./i.test(String(r.fieldA)) && !/\bauth\./i.test(String(r.fieldB));
      }
      case 'any':
        return (rule as any).rules.some((r: PolicyRule) => this.anonMayRead(r));
      case 'all':
        return (rule as any).rules.every((r: PolicyRule) => this.anonMayRead(r));
      case 'with_check':
        return this.anonMayRead((rule as any).using);
      default:
        return false;
    }
  }

  /** Does an explicit `policy.public()` let a request without a user write? */
  private anonMayWrite(rule: PolicyRule): boolean {
    switch (rule.kind) {
      case 'public':
        return true;
      case 'any':
        return (rule as any).rules.some((r: PolicyRule) => this.anonMayWrite(r));
      case 'all': {
        // An explicit public() branch, and no branch that needs a signed-in user.
        const rules = (rule as any).rules as PolicyRule[];
        return rules.some((r) => this.anonMayWrite(r)) && rules.every((r) => this.anonMayRead(r));
      }
      case 'with_check': {
        const wc = rule as any;
        return this.anonMayWrite(wc.using) && this.anonMayRead(wc.check);
      }
      default:
        return false;
    }
  }

  /** `Pick<T, required> & Partial<Pick<T, optional>>` for the Create type. */
  private createTypeExpr(interfaceName: string, tableDef: TableDef): string {
    const required: string[] = [];
    const optional: string[] = [];
    for (const [colName, rawColumnDef] of Object.entries(tableDef.columns)) {
      const col = normalizeColumn(rawColumnDef);
      const isPk = colName === singlePrimaryKey(tableDef);
      const autoPk = isPk && (baseType(col.type) === 'uuid' || baseType(col.type) === 'bigint');
      if (isNullable(col.type) || col.default !== undefined || autoPk) optional.push(colName);
      else required.push(colName);
    }
    const union = (names: string[]) => names.map((name) => `'${name}'`).join(' | ');
    if (optional.length === 0) return interfaceName;
    if (required.length === 0) return `Partial<${interfaceName}>`;
    return `Pick<${interfaceName}, ${union(required)}> & Partial<Pick<${interfaceName}, ${union(optional)}>>`;
  }

  private generateTypeInterfaces(schema: SchemaDef): string {
    const rpcs = (schema as any).__rpcs as Record<string, RpcDef> | undefined;
    const rpcEntries = rpcs ? Object.entries(rpcs) : [];
    const lines: string[] = [
      '// ============================================',
      '// AccessNexus: Auto-generated types',
      '// DO NOT EDIT — regenerate with `npx accessnexus generate`',
      '// ============================================',
      '',
    ];

    for (const [tableName, tableDef] of Object.entries(schema)) {
      const interfaceName = this.toPascalCase(tableName);

      lines.push(`export interface ${interfaceName} {`);

      for (const [colName, colDef] of Object.entries(tableDef.columns)) {
        const colType = typeof colDef === 'string' ? colDef : colDef.type;
        const tsType = this.columnTypeToTS(colType);
        lines.push(`  ${colName}: ${tsType};`);
      }

      lines.push(`}`);
      lines.push('');

      // Create/Update types. On create, nullable columns, columns with a
      // default and an auto-generated primary key (uuid/bigint) are optional.
      const pkCols = primaryKeyColumns(tableDef);
      const pk = (pkCols.length > 0 ? pkCols : ['id']).map((c) => `'${c}'`).join(' | ');
      lines.push(`export type ${interfaceName}Create = ${this.createTypeExpr(interfaceName, tableDef)};`);
      lines.push(`export type ${interfaceName}Update = Partial<Omit<${interfaceName}, ${pk}>>;`);
      lines.push('');
    }

    lines.push(`export interface Database {`);
    lines.push(`  public: {`);
    lines.push(`    Tables: {`);
    for (const tableName of Object.keys(schema)) {
      const interfaceName = this.toPascalCase(tableName);
      lines.push(`      ${tableName}: {`);
      lines.push(`        Row: ${interfaceName};`);
      lines.push(`        Insert: ${interfaceName}Create;`);
      lines.push(`        Update: ${interfaceName}Update;`);
      lines.push(`        Relationships: [];`);
      lines.push(`      };`);
    }
    lines.push(`    };`);
    lines.push(`    Views: Record<string, never>;`);
    lines.push(`    Functions: {`);
    for (const [name, def] of rpcEntries) {
      const argsType = def.args && Object.keys(def.args).length > 0
        ? `{ ${Object.entries(def.args).map(([k, v]) => {
          const a = normalizeRpcArg(v);
          return `${k}${a.default !== undefined ? '?' : ''}: ${this.columnTypeToTS(a.type)}`;
        }).join('; ')} }`
        : 'Record<string, never>';
      const returnsType = def.returns ? this.columnTypeToTS(def.returns) : 'unknown';
      lines.push(`      ${name}: {`);
      lines.push(`        Args: ${argsType};`);
      lines.push(`        Returns: ${returnsType};`);
      lines.push(`      };`);
    }
    lines.push(`    };`);
    lines.push(`    Enums: Record<string, never>;`);
    lines.push(`    CompositeTypes: Record<string, never>;`);
    lines.push(`  };`);
    lines.push(`}`);
    lines.push('');

    return lines.join('\n');
  }

  private generateClientCode(schema: SchemaDef): string {
    const rpcs = (schema as any).__rpcs as Record<string, RpcDef> | undefined;
    const rpcEntries = rpcs ? Object.entries(rpcs) : [];

    const lines: string[] = [
      '// ============================================',
      '// AccessNexus: Auto-generated client',
      '// DO NOT EDIT — regenerate with `npx accessnexus generate`',
      '// ============================================',
      '',
    ];

    // Import types
    const typeImports: string[] = [];
    for (const tableName of Object.keys(schema)) {
      const name = this.toPascalCase(tableName);
      typeImports.push(name, `${name}Create`, `${name}Update`);
    }
    lines.push(`import type { Database, ${typeImports.join(', ')} } from './types.js';`);
    lines.push(`type Tables = Database['public']['Tables'];`);
    lines.push(`type Functions = Database['public']['Functions'];`);
    lines.push(`type TableName = keyof Tables & string;`);
    lines.push(`type FunctionName = keyof Functions & string;`);
    lines.push(`type RowOf<T extends TableName> = Tables[T]['Row'];`);
    lines.push(`type InsertOf<T extends TableName> = Tables[T]['Insert'];`);
    lines.push(`type UpdateOf<T extends TableName> = Tables[T]['Update'];`);
    lines.push(`type QueryResult<T> = Promise<{ data: T | null; error: unknown }>;`);
    lines.push('');
    lines.push(`interface SelectQuery<T extends TableName> {`);
    lines.push(`  match(filter: Partial<RowOf<T>>): QueryResult<RowOf<T>[]>;`);
    lines.push(`  eq(column: string, value: unknown): SelectQuery<T>;`);
    lines.push(`  is(column: string, value: null): SelectQuery<T>;`);
    lines.push(`  single(): QueryResult<RowOf<T>>;`);
    lines.push(`}`);
    lines.push('');
    lines.push(`interface MutationQuery<T extends TableName> {`);
    lines.push(`  eq(column: string, value: unknown): MutationQuery<T>;`);
    lines.push(`  select(): SelectQuery<T>;`);
    lines.push(`}`);
    lines.push('');
    lines.push(`interface DeleteQuery<T extends TableName> {`);
    lines.push(`  eq(column: string, value: unknown): QueryResult<RowOf<T>[]>;`);
    lines.push(`}`);
    lines.push('');
    lines.push(`interface TableQuery<T extends TableName> {`);
    lines.push(`  select(columns: string): SelectQuery<T>;`);
    lines.push(`  insert(data: InsertOf<T>): MutationQuery<T>;`);
    lines.push(`  update(data: UpdateOf<T>): MutationQuery<T>;`);
    lines.push(`  delete(): DeleteQuery<T>;`);
    lines.push(`}`);
    lines.push('');
    lines.push(`type AccessNexusTransport = {`);
    lines.push(`  auth: unknown;`);
    lines.push(`  from<T extends TableName>(table: T): TableQuery<T>;`);
    lines.push(`  rpc<F extends FunctionName>(name: F, args: Functions[F]['Args']): QueryResult<Functions[F]['Returns']>;`);
    lines.push(`};`);
    lines.push('');
    lines.push(`// Loose shape a real Supabase client satisfies (its builders are thenables,`);
    lines.push(`// not Promises, so it cannot match AccessNexusTransport structurally).`);
    lines.push(`type AccessNexusProvider = {`);
    lines.push(`  auth: unknown;`);
    lines.push(`  from(table: string): unknown;`);
    lines.push(`  rpc(name: string, args?: object): unknown;`);
    lines.push(`};`);
    lines.push('');
    lines.push(`function buildSelectClause(`);
    lines.push(`  base: string,`);
    lines.push(`  joins: Record<string, string>,`);
    lines.push(`  include?: Record<string, true | undefined>,`);
    lines.push(`): string {`);
    lines.push(`  if (!include) return base;`);
    lines.push(`  const selected = Object.keys(include)`);
    lines.push(`    .filter((key) => include[key] === true && joins[key])`);
    lines.push(`    .map((key) => joins[key]);`);
    lines.push(`  if (selected.length === 0) return base;`);
    lines.push(`  return \`\${base}, \${selected.join(', ')}\`;`);
    lines.push(`}`);
    lines.push('');

    for (const tableName of Object.keys(schema)) {
      const relations = this.getTableRelations(schema, tableName);
      if (relations.length === 0) continue;

      const relTypeName = `${this.toPascalCase(tableName)}Relations`;
      const includeTypeName = `${this.toPascalCase(tableName)}Include`;
      const withIncludeTypeName = `${this.toPascalCase(tableName)}WithInclude`;
      const joinConstName = `${tableName}Joins`;

      lines.push(`type ${relTypeName} = {`);
      for (const relation of relations) {
        lines.push(`  '${relation.alias}': RowOf<'${relation.targetTable}'>;`);
      }
      lines.push(`};`);
      lines.push(`type ${includeTypeName} = Partial<Record<keyof ${relTypeName}, true>>;`);
      lines.push(`type ${withIncludeTypeName}<TInclude extends ${includeTypeName} | undefined> =`);
      lines.push(`  RowOf<'${tableName}'>`);
      for (const relation of relations) {
        lines.push(`  & (TInclude extends { '${relation.alias}': true } ? { '${relation.alias}': ${relTypeName}['${relation.alias}'] | null } : unknown)`);
      }
      lines.push(`;`);
      lines.push(`const ${joinConstName}: Record<keyof ${relTypeName} & string, string> = {`);
      for (const relation of relations) {
        lines.push(`  '${relation.alias}': '${relation.alias}:${relation.targetTable}!${relation.constraint}(*)',`);
      }
      lines.push(`};`);
      lines.push('');
    }

    // Client factory
    lines.push(`export function createAccessNexusClient<TClient extends AccessNexusProvider>(providerRaw: TClient) {`);
    lines.push(`  // Accept a real Supabase client (loose AccessNexusProvider) and use the strict`);
    lines.push(`  // AccessNexusTransport shape internally for the typed accessors below.`);
    lines.push(`  const provider = providerRaw as unknown as AccessNexusTransport;`);
    lines.push(`  return {`);
    lines.push(`    auth: providerRaw.auth,`);
    lines.push('');

    for (const [tableName, tableDef] of Object.entries(schema)) {
      const typeName = this.toPascalCase(tableName);
      const pk = singlePrimaryKey(tableDef) ?? 'id';
      const softDeleteColumn = tableDef.softDelete;
      const relations = this.getTableRelations(schema, tableName);
      const includeTypeName = `${this.toPascalCase(tableName)}Include`;
      const withIncludeTypeName = `${this.toPascalCase(tableName)}WithInclude`;
      const joinConstName = `${tableName}Joins`;

      lines.push(`    ${tableName}: {`);
      if (relations.length > 0) {
        lines.push(`      findMany: <TInclude extends ${includeTypeName} | undefined = undefined>(`);
        lines.push(`        filter?: Partial<${typeName}>,`);
        lines.push(`        options?: { include?: TInclude },`);
        lines.push(`      ) => {`);
        lines.push(`        const select = buildSelectClause('*', ${joinConstName}, options?.include as Record<string, true | undefined> | undefined);`);
        if (softDeleteColumn) {
          lines.push(`        return provider.from('${tableName}').select(select).is('${softDeleteColumn}', null).match(filter ?? {}) as QueryResult<${withIncludeTypeName}<TInclude>[]>;`);
        } else {
          lines.push(`        return provider.from('${tableName}').select(select).match(filter ?? {}) as QueryResult<${withIncludeTypeName}<TInclude>[]>;`);
        }
        lines.push(`      },`);
      } else {
        lines.push(`      findMany: (filter?: Partial<${typeName}>) =>`);
        if (softDeleteColumn) {
          lines.push(`        provider.from('${tableName}').select('*').is('${softDeleteColumn}', null).match(filter ?? {}),`);
        } else {
          lines.push(`        provider.from('${tableName}').select('*').match(filter ?? {}),`);
        }
      }
      lines.push('');
      if (relations.length > 0) {
        lines.push(`      findById: <TInclude extends ${includeTypeName} | undefined = undefined>(`);
        lines.push(`        id: string,`);
        lines.push(`        options?: { include?: TInclude },`);
        lines.push(`      ) => {`);
        lines.push(`        const select = buildSelectClause('*', ${joinConstName}, options?.include as Record<string, true | undefined> | undefined);`);
        if (softDeleteColumn) {
          lines.push(`        return provider.from('${tableName}').select(select).eq('${pk}', id).is('${softDeleteColumn}', null).single() as QueryResult<${withIncludeTypeName}<TInclude>>;`);
        } else {
          lines.push(`        return provider.from('${tableName}').select(select).eq('${pk}', id).single() as QueryResult<${withIncludeTypeName}<TInclude>>;`);
        }
        lines.push(`      },`);
      } else {
        lines.push(`      findById: (id: string) =>`);
        if (softDeleteColumn) {
          lines.push(`        provider.from('${tableName}').select('*').eq('${pk}', id).is('${softDeleteColumn}', null).single(),`);
        } else {
          lines.push(`        provider.from('${tableName}').select('*').eq('${pk}', id).single(),`);
        }
      }
      lines.push('');
      lines.push(`      create: (data: ${typeName}Create) =>`);
      lines.push(`        provider.from('${tableName}').insert(data).select().single(),`);
      lines.push('');
      lines.push(`      update: (id: string, data: ${typeName}Update) =>`);
      lines.push(`        provider.from('${tableName}').update(data).eq('${pk}', id).select().single(),`);
      lines.push('');
      lines.push(`      delete: (id: string) =>`);
      // On softDelete tables the BEFORE DELETE trigger turns this into
      // SET <column> = NOW(), so the DELETE policy (not UPDATE) decides it.
      lines.push(`        provider.from('${tableName}').delete().eq('${pk}', id),`);
      lines.push(`    },`);
      lines.push('');
    }

    // RPC namespace (manual mode — inline types from RPC definitions)
    if (rpcEntries.length > 0) {
      lines.push(`    rpc: {`);
      for (const [name, def] of rpcEntries) {
        if (def.args && Object.keys(def.args).length > 0) {
          lines.push(`      ${name}: (args: Functions['${name}']['Args']) =>`);
          lines.push(`        provider.rpc('${name}', args),`);
        } else {
          // No arguments: callable as \`client.rpc.${name}()\`.
          lines.push(`      ${name}: (args: Functions['${name}']['Args'] = {}) =>`);
          lines.push(`        provider.rpc('${name}', args),`);
        }
        lines.push('');
      }
      lines.push(`    },`);
      lines.push('');
    }

    lines.push(`  };`);
    lines.push(`}`);
    lines.push('');

    // Export type for the client
    lines.push(`export type AccessNexusClient = ReturnType<typeof createAccessNexusClient>;`);

    return lines.join('\n');
  }

  private toPascalCase(str: string): string {
    return str
      .split(/[_\-\s]+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join('');
  }
}

/** `{ type, default }` for an RPC argument given as a type string or an object. */
function normalizeRpcArg(arg: RpcArg): { type: string; default?: string } {
  return typeof arg === 'string' ? { type: arg } : { type: arg.type, default: arg.default };
}
