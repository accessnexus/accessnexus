// ============================================
// AccessNexus - Supabase Adapter
// Generates RLS policies for Supabase/PostgreSQL
// ============================================

import { baseType, isNullable, normalizeColumn } from '../../core/types/columns.js';
import { primaryKeyColumns, singlePrimaryKey } from '../../core/types/schema.js';
import type { RpcArg, RpcSetofReturn, RpcTableReturn } from '../../core/types/rpc.js';
import type { ChannelDef, ChannelRule } from '../../core/types/realtime.js';
import type { EdgeFunctionAuth, EdgeFunctionDef } from '../../core/types/edge-function.js';
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
  /**
   * Also emit `react-query.ts` in the SDK folder: TanStack Query v5
   * (`@tanstack/react-query`) query keys, `queryOptions` for every read and
   * mutation options for every write and RPC, wrapping the generated client.
   *
   * @default false
   */
  reactQuery?: boolean;
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
  /** Shared enums (`defineSchema(..., { enums })`) and tables of the schema being generated. */
  private namedEnums: Record<string, readonly string[]> = {};
  private schemaInUse: SchemaDef = {};

  /** Remember the schema's named enums and tables for type mapping (`enum:x`, `table.column`). */
  private useSchema(schema: SchemaDef): void {
    this.namedEnums = ((schema as any).__enums as Record<string, readonly string[]> | undefined) ?? {};
    this.schemaInUse = schema;
  }

  /**
   * A `'table.column'` type (RPC args / returns): that column's type, keeping
   * the reference's own `?`. Per-column enums map to `<table>_<column>_enum`.
   */
  private resolveColumnRef(type: string): { pg: string; ts: string } | null {
    const nullable = type.endsWith('?');
    const base = nullable ? type.slice(0, -1) : type;
    const m = /^([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)$/.exec(base);
    if (!m) return null;
    const col = this.schemaInUse[m[1]]?.columns?.[m[2]];
    if (col === undefined) return null;
    const colType = baseType(normalizeColumn(col).type);
    const pg = colType.startsWith('enum(') ? this.enumTypeName(m[1], m[2]) : this.columnTypeToPG(colType);
    const ts = this.columnTypeToTS(colType);
    return { pg, ts: nullable ? `${ts} | null` : ts };
  }

  constructor(options: SupabaseAdapterOptions = {}) {
    this.options = {
      policyPrefix: options.policyPrefix ?? 'accessnexus',
      schemaName: options.schemaName ?? 'public',
      idempotent: options.idempotent ?? true,
      timestamps: options.timestamps ?? true,
      forceRLS: options.forceRLS ?? true,
      uuidGeneration: options.uuidGeneration ?? 'v4',
      deterministic: options.deterministic ?? false,
      reactQuery: options.reactQuery ?? false,
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

    const realtime = this.generateRealtimeSQL(schema);
    if (realtime) outputs.push({ path: 'realtime.sql', content: realtime });

    return outputs;
  }

  // ---- Realtime ----

  /**
   * `realtime.sql` (policies folder): publication membership of the tables
   * that declare `realtime`, and the `realtime.messages` policies of
   * `channels`. Idempotent, so push re-applies it whenever it changes. `null`
   * when the schema uses neither.
   */
  generateRealtimeSQL(schema: SchemaDef): string | null {
    const channels = (schema as any).__channels as Record<string, ChannelDef> | undefined;
    const tables = Object.entries(schema).filter(([, def]) => def.realtime !== undefined);
    if (tables.length === 0 && channels === undefined) return null;

    const { schemaName, policyPrefix } = this.options;
    const lines: string[] = [];
    if (this.options.timestamps) {
      lines.push(`-- ============================================`);
      lines.push(`-- AccessNexus: Auto-generated Realtime setup`);
      if (!this.options.deterministic) {
        lines.push(`-- Generated at: ${new Date().toISOString()}`);
      }
      lines.push(`-- ============================================`);
      lines.push('');
    }

    if (tables.length > 0) {
      lines.push(`-- Postgres Changes: publication membership (supabase_realtime).`);
      lines.push(`-- Subscribers only receive rows their SELECT policy shows them.`);
      lines.push(`DO $$`);
      lines.push(`BEGIN`);
      lines.push(`  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN`);
      lines.push(`    RAISE WARNING 'AccessNexus: publication supabase_realtime does not exist; Realtime table changes were not applied';`);
      lines.push(`    RETURN;`);
      lines.push(`  END IF;`);
      for (const [tableName, def] of tables) {
        const inPublication = `SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = ${quoteLiteral(schemaName)} AND tablename = ${quoteLiteral(tableName)}`;
        if (def.realtime) {
          lines.push(`  IF NOT EXISTS (${inPublication}) THEN`);
          lines.push(`    ALTER PUBLICATION supabase_realtime ADD TABLE ${schemaName}.${tableName};`);
        } else {
          lines.push(`  IF EXISTS (${inPublication}) THEN`);
          lines.push(`    ALTER PUBLICATION supabase_realtime DROP TABLE ${schemaName}.${tableName};`);
        }
        lines.push(`  END IF;`);
      }
      lines.push(`END $$;`);
      lines.push('');
      for (const [tableName, def] of tables) {
        if (!def.realtime) continue;
        const identity = typeof def.realtime === 'object' && def.realtime.replicaIdentity === 'full' ? 'FULL' : 'DEFAULT';
        lines.push(`ALTER TABLE ${schemaName}.${tableName} REPLICA IDENTITY ${identity};`);
      }
      lines.push('');
    }

    if (channels !== undefined) {
      const policyNames: string[] = [];
      const statements: string[] = [];
      for (const [channelName, def] of Object.entries(channels)) {
        statements.push(`-- Channel ${channelName}: topic ${def.topic}${def.table ? ` (row of ${def.table})` : ''}`);
        for (const extension of ['broadcast', 'presence'] as const) {
          for (const action of ['receive', 'send'] as const) {
            const name = `${policyPrefix}_rt_${channelName}_${extension}_${action}`;
            statements.push(`DROP POLICY IF EXISTS "${name}" ON realtime.messages;`);
            const rule = def[extension]?.[action];
            if (rule === undefined || rule === false || (typeof rule === 'object' && rule.kind === 'none')) continue;
            policyNames.push(name);
            const condition = this.channelConditionSQL(schema, def, extension, rule);
            const role = rule === true ? 'authenticated' : this.policyRoleFor(action === 'receive' ? 'select' : 'insert', rule);
            if (action === 'receive') {
              statements.push(
                `CREATE POLICY "${name}"`,
                `  ON realtime.messages FOR SELECT`,
                `  TO ${role}`,
                `  USING (`,
                `    ${condition}`,
                `  );`,
              );
            } else {
              statements.push(
                `CREATE POLICY "${name}"`,
                `  ON realtime.messages FOR INSERT`,
                `  TO ${role}`,
                `  WITH CHECK (`,
                `    ${condition}`,
                `  );`,
              );
            }
          }
        }
        statements.push('');
      }

      lines.push(`-- Broadcast / Presence authorization: RLS on realtime.messages (private channels).`);
      lines.push(`-- Drop channel policies of this prefix that the schema no longer declares.`);
      lines.push(`DO $$`);
      lines.push(`DECLARE`);
      lines.push(`  stale record;`);
      lines.push(`BEGIN`);
      lines.push(`  FOR stale IN`);
      lines.push(`    SELECT policyname FROM pg_policies`);
      lines.push(`    WHERE schemaname = 'realtime' AND tablename = 'messages'`);
      lines.push(`      AND starts_with(policyname, ${quoteLiteral(`${policyPrefix}_rt_`)})`);
      if (policyNames.length > 0) {
        lines.push(`      AND policyname NOT IN (${policyNames.map((n) => quoteLiteral(n)).join(', ')})`);
      }
      lines.push(`  LOOP`);
      lines.push(`    EXECUTE format('DROP POLICY %I ON realtime.messages', stale.policyname);`);
      lines.push(`  END LOOP;`);
      lines.push(`END $$;`);
      lines.push('');
      lines.push(...statements);
    }

    return `${lines.join('\n').trimEnd()}\n`;
  }

  /** USING / WITH CHECK of one channel policy on realtime.messages. */
  private channelConditionSQL(
    schema: SchemaDef,
    def: ChannelDef,
    extension: 'broadcast' | 'presence',
    rule: Exclude<ChannelRule, false>,
  ): string {
    const topic = parseChannelTopic(def.topic);
    const param = topic.param
      ? `substr(realtime.topic(), ${topic.prefix.length + 1})`
      : undefined;
    const parts: string[] = [`realtime.messages.extension = ${quoteLiteral(extension)}`];
    if (topic.param) {
      parts.push(`left(realtime.topic(), ${topic.prefix.length}) = ${quoteLiteral(topic.prefix)}`);
      parts.push(`length(realtime.topic()) > ${topic.prefix.length}`);
    } else {
      parts.push(`realtime.topic() = ${quoteLiteral(topic.prefix)}`);
    }

    if (rule === true) {
      parts.push('(SELECT auth.uid()) IS NOT NULL');
    } else {
      let sql = this.ruleToSQL(rule);
      if (topic.param && param) {
        sql = sql.replaceAll(`{${topic.param}}`, param);
      }
      parts.push(`(${sql})`);
    }

    if (def.table && param) {
      const tableDef = schema[def.table];
      const pk = tableDef ? (singlePrimaryKey(tableDef) ?? 'id') : 'id';
      const pkType = tableDef?.columns[pk] !== undefined ? baseType(normalizeColumn(tableDef.columns[pk]).type) : undefined;
      // The topic parameter is text: compare without a cast that could raise on
      // a malformed topic, and keep the primary-key index usable.
      let match: string;
      if (pkType === 'uuid') {
        match = `${def.table}.${pk} = CASE WHEN ${param} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN ${param}::uuid END`;
      } else if (pkType === 'int' || pkType === 'smallint' || pkType === 'bigint' || pkType === 'serial') {
        match = `${def.table}.${pk} = CASE WHEN ${param} ~ '^[0-9]{1,18}$' THEN ${param}::bigint END`;
      } else if (pkType === 'text' || pkType === 'varchar') {
        match = `${def.table}.${pk} = ${param}`;
      } else {
        match = `${def.table}.${pk}::text = ${param}`;
      }
      // Runs as the subscriber, so the table's own SELECT policy decides.
      parts.push(`EXISTS (SELECT 1 FROM ${this.options.schemaName}.${def.table} WHERE ${match})`);
    }

    return parts.join('\n    AND ');
  }

  /** Typed SDK files (`types.ts` + `client.ts`, or `client.ts` in Database mode). */
  generateClient(schema: SchemaDef): GeneratedOutput[] {
    this.useSchema(schema);
    // Detect Database mode: all tables have empty columns
    const isDatabaseMode = Object.values(schema).every(
      (t) => Object.keys(t.columns).length === 0
    );

    const files: GeneratedOutput[] = isDatabaseMode
      ? this.generateDatabaseModeClient(schema)
      : [
          { path: 'types.ts', content: this.generateTypeInterfaces(schema) },
          { path: 'client.ts', content: this.generateClientCode(schema) },
        ];
    if (this.options.reactQuery) {
      files.push({ path: 'react-query.ts', content: this.generateReactQueryCode(schema) });
    }
    return files;
  }

  /** Full DDL (`001_initial.sql`): enums, tables, FKs, indexes. Empty in Database mode. */
  generateMigrations(schema: SchemaDef): GeneratedOutput[] {
    this.useSchema(schema);
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

    // Shared enums (defineEnum) first: columns of any table may use them.
    const namedEnumStatements = Object.entries(this.namedEnums).map(([name, values]) =>
      this.createEnumSQL(name, `enum(${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(',')})`));
    if (namedEnumStatements.length > 0 || enumStatements.length > 0) {
      lines.push(...namedEnumStatements, ...enumStatements);
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

      case 'shares_tenant': {
        const r = rule as any;
        const helper = this.policyHelperFnBySignature.get(this.belongsToSignature(rule));
        if (helper) return `(SELECT ${helper}(${r.column}))`;
        const m = r.membership;
        return `${r.column} IN (SELECT them.${m.userColumn} FROM ${this.qualifyTable(m.table)} me JOIN ${this.qualifyTable(m.table)} them ON them.${m.tenantColumn} = me.${m.tenantColumn} WHERE me.${m.userColumn} = (SELECT auth.uid()))`;
      }

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

      const sql = this.generateTableTriggers(tableName, tableDef, schema);
      outputs.push({
        path: `${tableName}_triggers.sql`,
        content: sql,
      });
    }

    return outputs;
  }

  private generateTableTriggers(tableName: string, tableDef: TableDef, schema?: SchemaDef): string {
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
      lines.push(this.triggerRuleToSQL(rule, tableName, tableDef, schema));
      lines.push('');
    }

    return lines.join('\n');
  }

  /** Convert a TriggerRule to complete SQL (function + trigger) */
  triggerRuleToSQL(rule: TriggerRule, tableName: string, tableDef: TableDef, schema?: SchemaDef): string {
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

        // INVOKER: current_user is the API role for PostgREST requests and the
        // owner inside SECURITY DEFINER code, which is therefore never blocked.
        const applies = [
          `current_user IN ('anon', 'authenticated')`,
          ...(r.unless ? [`NOT COALESCE((${r.unless}), FALSE)`] : []),
        ].join(' AND ');
        // The error names the column (message) and carries a stable HINT
        // 'accessnexus:locked_column:<table>.<column>' for the SDK's isLockedColumn().
        const raise = (column: string, indent: string) => [
          `${indent}RAISE EXCEPTION '%', ${quoteLiteral(`${tableName}.`)} || ${column} || ' cannot be changed'`,
          `${indent}  USING ERRCODE = '42501', HINT = ${quoteLiteral(`accessnexus:locked_column:${tableName}.`)} || ${column};`,
        ];
        let body: string[];
        if (Array.isArray(r.except)) {
          const free = [...new Set([...(r.except as string[]), ...managed])];
          const keys = `ARRAY[${free.map((c) => quoteLiteral(c)).join(', ')}]::text[]`;
          body = [
            `DECLARE`,
            `  locked_column text;`,
            `BEGIN`,
            `  IF ${applies} THEN`,
            `    SELECT n.key INTO locked_column`,
            `      FROM jsonb_each(to_jsonb(NEW) - ${keys}) AS n`,
            `     WHERE n.value IS DISTINCT FROM (to_jsonb(OLD) -> n.key)`,
            `     ORDER BY n.key LIMIT 1;`,
            `    IF locked_column IS NOT NULL THEN`,
            ...raise('locked_column', '      '),
            `    END IF;`,
            `  END IF;`,
            `  RETURN NEW;`,
            `END;`,
          ];
        } else {
          const locked = (r.columns as string[]).filter((c) => !managed.includes(c));
          body = [
            `BEGIN`,
            `  IF ${applies} THEN`,
            ...locked.flatMap((c) => [
              `    IF NEW.${c} IS DISTINCT FROM OLD.${c} THEN`,
              ...raise(quoteLiteral(c), '      '),
              `    END IF;`,
            ]),
            `  END IF;`,
            `  RETURN NEW;`,
            `END;`,
          ];
        }

        return [
          `CREATE OR REPLACE FUNCTION ${fnName}()`,
          `RETURNS TRIGGER AS $$`,
          ...body,
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

      case 'keep_at_least_one': {
        const r = rule as any;
        const suffix = r.name ?? `keep_${r.column}_${String(r.value).replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
        const fnName = `${policyPrefix}_${tableName}_${suffix}_fn`;
        const trgName = `${policyPrefix}_${tableName}_${suffix}`;
        const pk = singlePrimaryKey(tableDef) ?? 'id';
        const target = `${this.options.schemaName}.${tableName}`;
        const value = quoteLiteral(r.value);
        const parentCheck = r.parent
          ? (() => {
              const [pt, pc] = String(r.parent).split('.');
              return [`     AND EXISTS (SELECT 1 FROM ${this.options.schemaName}.${pt} p WHERE p.${pc} = OLD.${r.scope})`];
            })()
          : [];
        return [
          `CREATE OR REPLACE FUNCTION ${fnName}()`,
          `RETURNS TRIGGER AS $$`,
          `BEGIN`,
          `  IF OLD.${r.column} = ${value}`,
          `     AND (TG_OP = 'DELETE' OR NEW.${r.column} IS DISTINCT FROM OLD.${r.column} OR NEW.${r.scope} IS DISTINCT FROM OLD.${r.scope})`,
          ...parentCheck,
          `  THEN`,
          `    -- Serialize concurrent removals in the same scope.`,
          `    PERFORM 1 FROM ${target} m WHERE m.${r.scope} = OLD.${r.scope} AND m.${r.column} = ${value} FOR UPDATE;`,
          `    IF NOT EXISTS (`,
          `      SELECT 1 FROM ${target} m`,
          `      WHERE m.${r.scope} = OLD.${r.scope} AND m.${r.column} = ${value} AND m.${pk} <> OLD.${pk}`,
          `    ) THEN`,
          `      RAISE EXCEPTION ${quoteLiteral(`${tableName}: each ${r.scope} needs at least one ${r.column} = ${r.value}`)}`,
          `        USING ERRCODE = '23514';`,
          `    END IF;`,
          `  END IF;`,
          `  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;`,
          `  RETURN NEW;`,
          `END;`,
          `$$ LANGUAGE plpgsql`,
          `SECURITY DEFINER`,
          `${searchPath};`,
          '',
          ...(idempotent ? [`DROP TRIGGER IF EXISTS ${trgName} ON ${tableName};`] : []),
          `CREATE TRIGGER ${trgName}`,
          `  BEFORE UPDATE OR DELETE ON ${tableName}`,
          `  FOR EACH ROW`,
          `  EXECUTE FUNCTION ${fnName}();`,
        ].join('\n');
      }

      case 'same_tenant':
      case 'member_of_tenant': {
        const r = rule as any;
        const isMember = rule.kind === 'member_of_tenant';
        const suffix = r.name ?? `${isMember ? 'member_of_tenant' : 'same_tenant'}_${r.column}`;
        const fnName = `${policyPrefix}_${tableName}_${suffix}_fn`;
        const trgName = `${policyPrefix}_${tableName}_${suffix}`;
        let exists: string;
        let label: string;
        if (isMember) {
          const own = r.tenantColumn ?? r.tenant.tenantColumn;
          exists = `SELECT 1 FROM ${this.options.schemaName}.${r.tenant.table} m WHERE m.${r.tenant.userColumn} = NEW.${r.column} AND m.${r.tenant.tenantColumn} = NEW.${own}`;
          label = `is not a member of`;
        } else {
          const refDef = schema?.[r.references];
          const refPk = refDef ? (singlePrimaryKey(refDef) ?? 'id') : 'id';
          const theirs = r.referencesTenantColumn ?? r.tenantColumn;
          exists = `SELECT 1 FROM ${this.options.schemaName}.${r.references} p WHERE p.${refPk} = NEW.${r.column} AND p.${theirs} = NEW.${r.tenantColumn}`;
          label = `is not in`;
        }
        const tenantOf = isMember ? (r.tenantColumn ?? r.tenant.tenantColumn) : r.tenantColumn;
        return [
          `CREATE OR REPLACE FUNCTION ${fnName}()`,
          `RETURNS TRIGGER AS $$`,
          `BEGIN`,
          `  -- Runs as the writer: a row they cannot see counts as missing (no existence oracle).`,
          `  IF NEW.${r.column} IS NOT NULL AND NOT EXISTS (${exists}) THEN`,
          `    RAISE EXCEPTION '%', ${quoteLiteral(`${tableName}.${r.column} `)} || NEW.${r.column} || ${quoteLiteral(` ${label} ${tenantOf} `)} || NEW.${tenantOf}`,
          `      USING ERRCODE = '23503';`,
          `  END IF;`,
          `  RETURN NEW;`,
          `END;`,
          `$$ LANGUAGE plpgsql`,
          `${searchPath};`,
          '',
          ...(idempotent ? [`DROP TRIGGER IF EXISTS ${trgName} ON ${tableName};`] : []),
          `CREATE TRIGGER ${trgName}`,
          `  BEFORE INSERT OR UPDATE ON ${tableName}`,
          `  FOR EACH ROW`,
          `  EXECUTE FUNCTION ${fnName}();`,
        ].join('\n');
      }

      case 'on_auth_user_created': {
        const r = rule as any;
        const suffix = r.name ?? 'on_auth_user_created';
        const fnName = `${policyPrefix}_${tableName}_${suffix}_fn`;
        const trgName = `${policyPrefix}_${tableName}_${suffix}`;
        const cols = Object.keys(r.columns);
        const exprs = cols.map((c) => r.columns[c]);
        return [
          `-- New auth user → row in ${tableName} (no client-side "ensure profile").`,
          `CREATE OR REPLACE FUNCTION ${fnName}()`,
          `RETURNS TRIGGER AS $$`,
          `BEGIN`,
          `  INSERT INTO ${this.options.schemaName}.${tableName} (${cols.join(', ')})`,
          `  VALUES (${exprs.join(', ')})`,
          `  ON CONFLICT DO NOTHING;`,
          `  RETURN NEW;`,
          `END;`,
          `$$ LANGUAGE plpgsql`,
          `SECURITY DEFINER`,
          `${searchPath};`,
          `REVOKE EXECUTE ON FUNCTION ${fnName}() FROM PUBLIC, anon, authenticated;`,
          '',
          ...(idempotent ? [`DROP TRIGGER IF EXISTS ${trgName} ON auth.users;`] : []),
          `CREATE TRIGGER ${trgName}`,
          `  AFTER INSERT ON auth.users`,
          `  FOR EACH ROW`,
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
    this.useSchema(schema);
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
      const returnsPG = this.rpcReturnsToPG(name, def.returns);

      // Build function body
      const trimmedBody = def.body.trim();
      const hasOwnBlock = /^DECLARE\b/i.test(trimmedBody) || /^BEGIN\b/i.test(trimmedBody);
      const bodyContent = language === 'plpgsql' && !hasOwnBlock
        ? [`BEGIN`, `  ${trimmedBody}`, `END;`]
        : [trimmedBody];

      lines.push(...this.rpcReplaceGuard(name, def));
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

  /** `RETURNS` clause body of an rpc(): scalar, VOID, TABLE(...) or SETOF ... */
  private rpcReturnsToPG(name: string, returns: RpcDef['returns']): string {
    if (returns === undefined) return 'VOID';
    if (typeof returns === 'string') return this.columnTypeToPG(returns);
    if (isTableReturn(returns)) {
      const cols = Object.entries(returns.table);
      if (cols.length === 0) {
        throw new Error(`[AccessNexus] rpc ${name}: returns.table needs at least one column`);
      }
      return `TABLE(${cols.map(([col, type]) => `${col} ${this.columnTypeToPG(type)}`).join(', ')})`;
    }
    if (isSetofReturn(returns)) {
      return `SETOF ${isRpcScalarType(returns.setof) ? this.columnTypeToPG(returns.setof) : returns.setof}`;
    }
    throw new Error(`[AccessNexus] rpc ${name}: returns must be a column type, 'void', { table: {...} } or { setof: '...' }`);
  }

  /**
   * Postgres cannot change a function's result type (scalar, TABLE columns,
   * SETOF) or its argument names with CREATE OR REPLACE ("cannot change return
   * type of existing function"). Before replacing, drop the existing function
   * when its argument names or result differ from the definition. Both sides
   * are compared in Postgres' own spelling (format_type), so an unchanged
   * function is never dropped. DROP (no CASCADE) fails when a policy, view or
   * other function depends on it, which rolls the whole push back.
   */
  private rpcReplaceGuard(name: string, def: RpcDef): string[] {
    const fmt = (type: string) => `pg_catalog.format_type(pg_catalog.to_regtype(${quoteLiteral(type)}), NULL)`;
    const args = Object.entries(def.args ?? {}).map(([argName, arg]) => [argName, this.columnTypeToPG(normalizeRpcArg(arg).type)] as const);
    const signature = `${name}(${args.map(([, type]) => type).join(', ')})`;
    const wantArgs = args.length === 0
      ? `''`
      : args.map(([argName, type], i) => `${quoteLiteral(`${i > 0 ? ', ' : ''}${argName} `)} || ${fmt(type)}`).join(' || ');
    const returns = def.returns;
    let wantResult: string;
    if (returns !== undefined && typeof returns === 'object' && isTableReturn(returns)) {
      const cols = Object.entries(returns.table);
      wantResult = `'TABLE(' || ${cols.map(([col, type], i) => `${quoteLiteral(`${i > 0 ? ', ' : ''}${col} `)} || ${fmt(this.columnTypeToPG(type))}`).join(' || ')} || ')'`;
    } else if (returns !== undefined && typeof returns === 'object' && isSetofReturn(returns)) {
      const target = isRpcScalarType(returns.setof) ? this.columnTypeToPG(returns.setof) : returns.setof;
      wantResult = `'SETOF ' || ${fmt(target)}`;
    } else {
      wantResult = fmt(this.rpcReturnsToPG(name, returns));
    }
    return [
      `-- CREATE OR REPLACE cannot change the result type or argument names: drop ${name} first when they differ.`,
      `DO $$`,
      `DECLARE`,
      `  fn regprocedure := pg_catalog.to_regprocedure(${quoteLiteral(signature)});`,
      `  want_args text := ${wantArgs};`,
      `  want_result text := ${wantResult};`,
      `BEGIN`,
      `  IF fn IS NOT NULL AND want_args IS NOT NULL AND want_result IS NOT NULL`,
      `     AND (pg_catalog.pg_get_function_identity_arguments(fn) IS DISTINCT FROM want_args`,
      `          OR pg_catalog.pg_get_function_result(fn) IS DISTINCT FROM want_result) THEN`,
      `    DROP FUNCTION ${signature};`,
      `  END IF;`,
      `END $$;`,
    ];
  }

  /** TypeScript type of an rpc()'s result, matching `supabase gen types`. */
  private rpcReturnsToTS(schema: SchemaDef, returns: RpcDef['returns']): string {
    if (returns === undefined) return 'unknown';
    if (typeof returns === 'string') return this.columnTypeToTS(returns);
    if (isTableReturn(returns)) {
      const cols = Object.entries(returns.table);
      if (cols.length === 0) return 'Json';
      return `{ ${cols.map(([col, type]) => `${col}: ${this.columnTypeToTS(type)}`).join('; ')} }[]`;
    }
    if (isSetofReturn(returns)) {
      if (isRpcScalarType(returns.setof)) {
        const ts = this.columnTypeToTS(returns.setof);
        return /[|\s]/.test(ts) ? `(${ts})[]` : `${ts}[]`;
      }
      return Object.prototype.hasOwnProperty.call(schema, returns.setof) ? `${this.toPascalCase(returns.setof)}[]` : 'Json';
    }
    return 'Json';
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
    if (base.startsWith('enum:')) return base.slice(5);
    const ref = this.resolveColumnRef(base);
    if (ref) return ref.pg;

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
    const lines: string[] = [
      '// ============================================',
      '// AccessNexus: Auto-generated typed client',
      '// Uses your Supabase Database types directly',
      '// DO NOT EDIT — regenerate with `npx accessnexus generate`',
      '// ============================================',
      '',
      `import type { Database } from '${dbTypesPath}';`,
      '',
    ];
    this.emitClientBody(schema, lines, 'database');
    return [
      { path: 'client.ts', content: lines.join('\n') },
    ];
  }

  /**
   * Shared body of the generated client (both modes): helper types, relation
   * maps and the `createAccessNexusClient` factory. In manual mode the table
   * accessors name the types from `types.ts`; in Database mode they index the
   * user's Supabase `Database` type, so rows are exactly Supabase's.
   */
  private emitClientBody(schema: SchemaDef, lines: string[], mode: 'manual' | 'database'): void {
    const rpcs = (schema as any).__rpcs as Record<string, RpcDef> | undefined;
    const rpcEntries = rpcs ? Object.entries(rpcs) : [];
    const channels = Object.entries(((schema as any).__channels as Record<string, ChannelDef> | undefined) ?? {});
    const realtimeTables = Object.entries(schema).filter(([, def]) => !!def.realtime).map(([name]) => name);
    const usesRealtime = realtimeTables.length > 0 || channels.length > 0;
    const hasSoftDelete = Object.values(schema).some((def) => !!def.softDelete);
    const hasHardDelete = Object.values(schema).some((def) => !def.softDelete);
    const edgeFunctions = Object.entries(edgeFunctionsOf(schema) ?? {});

    lines.push(
      `type Tables = Database['public']['Tables'];`,
      ...(rpcEntries.length > 0 ? [`type Functions = Database['public']['Functions'];`] : []),
      `type TableName = keyof Tables & string;`,
      `type RowOf<T extends TableName> = Tables[T]['Row'];`,
      `type QueryResult<T> = Promise<{ data: T | null; error: unknown }>;`,
      '',
      `/** Column names of a table, for the \`columns\` option of the find* methods. */`,
      `export type ColumnsOf<T extends TableName> = readonly (keyof RowOf<T> & string)[];`,
      `/** The row narrowed to the selected \`columns\` (the whole row when omitted). */`,
      `export type SelectedRow<T extends TableName, TColumns extends ColumnsOf<T> | undefined> =`,
      `  TColumns extends readonly (infer K extends keyof RowOf<T>)[] ? Pick<RowOf<T>, K> : RowOf<T>;`,
      `/**`,
      ` * Filter of the *One/*Many writes: column → value, naming at least one column`,
      ` * of the table (\`{}\` and unknown columns are type errors).`,
      ` */`,
      `export type RowFilter<T extends TableName, TFilter> = TFilter`,
      `  & { [K in Exclude<keyof TFilter, keyof RowOf<T>>]: never }`,
      `  & (keyof TFilter extends never ? { 'filter must name at least one column': never } : unknown);`,
      '',
      `// Runtime guard of the *One/*Many writes: never update or delete every row.`,
      `function requireFilter(filter: object | null | undefined, method: string): object {`,
      `  const entries = Object.entries(filter ?? {}).filter(([, value]) => value !== undefined);`,
      `  if (entries.length === 0) {`,
      `    throw new Error(\`[AccessNexus] \${method}: the filter must name at least one column (refusing to write every row)\`);`,
      `  }`,
      `  return Object.fromEntries(entries);`,
      `}`,
      '',
      `/** Code of the error a write gets when no row it may change matches (missing, or RLS hides/denies it). */`,
      `export const NOT_FOUND_OR_DENIED = 'ACCESSNEXUS_NOT_FOUND_OR_DENIED';`,
      `/** Error built by the SDK itself (writes that matched no row the caller may change). */`,
      `export type AccessNexusError = { code: string; message: string; details: Record<string, unknown>; hint: string };`,
      '',
      `function notFoundOrDenied(table: string, method: string, details: Record<string, unknown>): AccessNexusError {`,
      `  return {`,
      `    code: NOT_FOUND_OR_DENIED,`,
      `    message: \`\${table}.\${method}: no row was changed — it does not exist, or RLS does not let you change it\`,`,
      `    details: { table, method, ...details },`,
      `    hint: 'RLS hides rows you may not see and skips rows you may not write; check the row id and the policies.',`,
      `  };`,
      `}`,
      '',
      `/** True for the SDK's "no row changed" error (missing row, or denied by RLS). */`,
      `export function isNotFoundOrDenied(error: unknown): boolean {`,
      `  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === NOT_FOUND_OR_DENIED;`,
      `}`,
      '',
      `/**`,
      ` * True when the database refused the request: the SDK's NOT_FOUND_OR_DENIED, or SQLSTATE`,
      ` * 42501 (an INSERT / WITH CHECK rejected by RLS, a locked column, a definer RPC check).`,
      ` */`,
      `export function isAccessDenied(error: unknown): boolean {`,
      `  return isNotFoundOrDenied(error) || (!!error && typeof error === 'object' && (error as { code?: unknown }).code === '42501');`,
      `}`,
      '',
      `/** True when a \`trigger.lockColumns\` guard refused the update (SQLSTATE 42501, stable hint). */`,
      `export function isLockedColumn(error: unknown): boolean {`,
      `  if (!error || typeof error !== 'object') return false;`,
      `  const e = error as { code?: unknown; hint?: unknown };`,
      `  return e.code === '42501' && typeof e.hint === 'string' && e.hint.startsWith('accessnexus:locked_column:');`,
      `}`,
      '',
      `type RawResult = { data: unknown; error: unknown; count?: number | null };`,
      '',
      `// One-row writes: no row back (and no error) means nothing was changed.`,
      `async function changedOne(table: string, method: string, details: Record<string, unknown>, run: PromiseLike<unknown>): Promise<{ data: unknown; error: unknown }> {`,
      `  const res = (await run) as RawResult;`,
      `  if (res.error) return { data: null, error: res.error };`,
      `  if (res.data === null || res.data === undefined) return { data: null, error: notFoundOrDenied(table, method, details) };`,
      `  return { data: res.data, error: null };`,
      `}`,
      '',
      ...(hasHardDelete ? [
      `// DELETE by key: the affected-row count tells a real delete from one RLS skipped.`,
      `async function deletedById(table: string, id: unknown, run: PromiseLike<unknown>): Promise<{ data: null; error: unknown }> {`,
      `  const res = (await run) as RawResult;`,
      `  if (res.error) return { data: null, error: res.error };`,
      `  if (res.count === 0) return { data: null, error: notFoundOrDenied(table, 'delete', { id }) };`,
      `  return { data: null, error: null };`,
      `}`,
      '',
      ] : []),
      ...(hasSoftDelete ? [
      `// Soft-delete tables: the trigger turns DELETE into an UPDATE, so the DELETE reports 0 rows`,
      `// either way. Look at the live row before and after: gone means deleted, still there means denied.`,
      `async function softDeleted(`,
      `  table: string, method: string, details: Record<string, unknown>,`,
      `  before: () => PromiseLike<unknown>, remove: () => PromiseLike<unknown>, after: () => PromiseLike<unknown>,`,
      `): Promise<{ data: unknown; error: unknown }> {`,
      `  const pre = (await before()) as RawResult;`,
      `  if (pre.error) return { data: null, error: pre.error };`,
      `  if (pre.data === null || pre.data === undefined) return { data: null, error: notFoundOrDenied(table, method, details) };`,
      `  const del = (await remove()) as RawResult;`,
      `  if (del.error) return { data: null, error: del.error };`,
      `  const post = (await after()) as RawResult;`,
      `  if (post.error) return { data: null, error: post.error };`,
      `  if (post.data !== null && post.data !== undefined) return { data: null, error: notFoundOrDenied(table, method, details) };`,
      `  return { data: method === 'delete' ? null : pre.data, error: null };`,
      `}`,
      '',
      ] : []),
      `// Internal, loosely typed view of the Supabase query builder. Results are`,
      `// typed per method below.`,
      `interface QueryBuilder extends PromiseLike<unknown> {`,
      `  select(columns?: string): QueryBuilder;`,
      `  insert(data: object): QueryBuilder;`,
      `  update(data: object): QueryBuilder;`,
      `  delete(options?: { count?: 'exact' }): QueryBuilder;`,
      `  match(filter: object): QueryBuilder;`,
      `  eq(column: string, value: unknown): QueryBuilder;`,
      `  is(column: string, value: null): QueryBuilder;`,
      `  single(): QueryBuilder;`,
      `  maybeSingle(): QueryBuilder;`,
      `}`,
      '',
      ...(usesRealtime ? [
        `// Internal, loosely typed view of a supabase-js RealtimeChannel.`,
        `interface RealtimeChannelLike {`,
        `  on(type: string, filter: object, callback: (payload: unknown) => void): RealtimeChannelLike;`,
        `  subscribe(callback?: (status: string, error?: Error) => void): unknown;`,
        `}`,
        '',
      ] : []),
      `type AccessNexusTransport = {`,
      `  from(table: string): QueryBuilder;`,
      `  rpc(name: string, args: object): QueryBuilder;`,
      ...(usesRealtime ? [
        `  channel?(name: string, options?: object): RealtimeChannelLike;`,
        `  removeChannel?(channel: RealtimeChannelLike): unknown;`,
      ] : []),
      ...(edgeFunctions.length > 0 ? [
        `  functions?: { invoke(name: string, options: object): PromiseLike<unknown> };`,
      ] : []),
      `};`,
      '',
      `/**`,
      ` * Loose shape a real Supabase client satisfies (\`createClient\`, or`,
      ` * \`createBrowserClient\` / \`createServerClient\` from @supabase/ssr).`,
      ` */`,
      `export type AccessNexusProvider = {`,
      `  auth: unknown;`,
      `  from(table: string): unknown;`,
      `  rpc(name: string, args?: object): unknown;`,
      ...(usesRealtime ? [
        `  channel?(name: string, options?: object): unknown;`,
        `  removeChannel?(channel: never): unknown;`,
      ] : []),
      ...(edgeFunctions.length > 0 ? [`  functions?: unknown;`] : []),
      `};`,
      '',
      ...(usesRealtime ? this.realtimeClientHelpers(realtimeTables.length > 0, channels.length > 0) : []),
      ...(edgeFunctions.length > 0 ? this.edgeFunctionClientHelpers(edgeFunctions) : []),
      `function selectClause(`,
      `  columns: readonly string[] | undefined,`,
      `  joins?: Record<string, string>,`,
      `  include?: Record<string, true | undefined>,`,
      `): string {`,
      `  // Column names are checked at compile time (ColumnsOf); an empty list means all.`,
      `  const parts = columns && columns.length > 0 ? [...columns] : ['*'];`,
      `  if (joins && include) {`,
      `    for (const key of Object.keys(include)) {`,
      `      if (include[key] === true && joins[key]) parts.push(joins[key]);`,
      `    }`,
      `  }`,
      `  return parts.join(', ');`,
      `}`,
      '',
    );

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
      lines.push(`export type ${includeTypeName} = Partial<Record<keyof ${relTypeName}, true>>;`);
      lines.push(`type ${withIncludeTypeName}<TInclude extends ${includeTypeName} | undefined, TRow = RowOf<'${tableName}'>> =`);
      lines.push(`  TRow`);
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
    lines.push(`  // Accept a real Supabase client (loose AccessNexusProvider) and use the`);
    lines.push(`  // internal QueryBuilder view for the typed accessors below.`);
    lines.push(`  const provider = providerRaw as unknown as AccessNexusTransport;`);
    lines.push(`  return {`);
    lines.push(`    // Typed as the client you passed in (e.g. SupabaseAuthClient).`);
    lines.push(`    auth: providerRaw.auth as TClient['auth'],`);
    lines.push('');

    for (const [tableName, tableDef] of Object.entries(schema)) {
      const typeName = this.toPascalCase(tableName);
      const pk = singlePrimaryKey(tableDef) ?? 'id';
      const softDeleteColumn = tableDef.softDelete;
      const relations = this.getTableRelations(schema, tableName);
      const includeTypeName = `${typeName}Include`;
      const withIncludeTypeName = `${typeName}WithInclude`;
      const joinConstName = `${tableName}Joins`;
      const rowType = mode === 'manual' ? typeName : `RowOf<'${tableName}'>`;
      const insertType = mode === 'manual' ? `${typeName}Create` : `Tables['${tableName}']['Insert']`;
      const updateType = mode === 'manual' ? `${typeName}Update` : `Tables['${tableName}']['Update']`;
      const hasRel = relations.length > 0;
      const generics = hasRel
        ? `<TColumns extends ColumnsOf<'${tableName}'> | undefined = undefined, TInclude extends ${includeTypeName} | undefined = undefined>`
        : `<TColumns extends ColumnsOf<'${tableName}'> | undefined = undefined>`;
      const optionsType = hasRel ? `{ columns?: TColumns; include?: TInclude }` : `{ columns?: TColumns }`;
      const resultRow = hasRel
        ? `${withIncludeTypeName}<TInclude, SelectedRow<'${tableName}', TColumns>>`
        : `SelectedRow<'${tableName}', TColumns>`;
      const selectExpr = hasRel
        ? `selectClause(options?.columns, ${joinConstName}, options?.include as Record<string, true | undefined> | undefined)`
        : `selectClause(options?.columns)`;
      const live = softDeleteColumn ? `.is('${softDeleteColumn}', null)` : '';
      const from = `provider.from('${tableName}')`;

      lines.push(`    ${tableName}: {`);
      lines.push(`      findMany: ${generics}(`);
      lines.push(`        filter?: Partial<${rowType}>,`);
      lines.push(`        options?: ${optionsType},`);
      lines.push(`      ) =>`);
      lines.push(`        ${from}.select(${selectExpr})${live}.match(filter ?? {}) as unknown as QueryResult<${resultRow}[]>,`);
      lines.push('');
      lines.push(`      // The row matching \`filter\`, or \`data: null\` (no error) when none does;`);
      lines.push(`      // more than one match is an error (PGRST116): filter on a unique column.`);
      lines.push(`      findOne: ${generics}(`);
      lines.push(`        filter: Partial<${rowType}>,`);
      lines.push(`        options?: ${optionsType},`);
      lines.push(`      ) =>`);
      lines.push(`        ${from}.select(${selectExpr})${live}.match(filter).maybeSingle() as unknown as QueryResult<${resultRow}>,`);
      lines.push('');
      lines.push(`      // \`data: null\` (no error) when the row does not exist or is not visible.`);
      lines.push(`      findById: ${generics}(`);
      lines.push(`        id: string,`);
      lines.push(`        options?: ${optionsType},`);
      lines.push(`      ) =>`);
      lines.push(`        ${from}.select(${selectExpr}).eq('${pk}', id)${live}.maybeSingle() as unknown as QueryResult<${resultRow}>,`);
      lines.push('');
      lines.push(`      create: (data: ${insertType}) =>`);
      lines.push(`        ${from}.insert(data).select().single() as unknown as QueryResult<${rowType}>,`);
      lines.push('');
      lines.push(`      // The updated row; error NOT_FOUND_OR_DENIED when no row was changed`);
      lines.push(`      // (it does not exist, or RLS hides it / denies the update).`);
      lines.push(`      update: (id: string, data: ${updateType}) =>`);
      lines.push(`        changedOne('${tableName}', 'update', { id }, ${from}.update(data).eq('${pk}', id).select().maybeSingle()) as unknown as QueryResult<${rowType}>,`);
      lines.push('');
      lines.push(`      // Error NOT_FOUND_OR_DENIED when nothing was deleted (missing row, or RLS).`);
      lines.push(`      delete: (id: string) =>`);
      if (softDeleteColumn) {
        // The BEFORE DELETE trigger turns this into SET <column> = NOW(), so the
        // DELETE policy (not UPDATE) decides it; the live row is checked around it.
        lines.push(`        softDeleted('${tableName}', 'delete', { id },`);
        lines.push(`          () => ${from}.select('${pk}').eq('${pk}', id)${live}.maybeSingle(),`);
        lines.push(`          () => ${from}.delete().eq('${pk}', id),`);
        lines.push(`          () => ${from}.select('${pk}').eq('${pk}', id)${live}.maybeSingle(),`);
        lines.push(`        ) as unknown as QueryResult<null>,`);
      } else {
        lines.push(`        deletedById('${tableName}', id, ${from}.delete({ count: 'exact' }).eq('${pk}', id)) as unknown as QueryResult<null>,`);
      }
      lines.push('');
      // Filtered writes. The filter is required (type and runtime) so a
      // mistake never writes the whole table; RLS still decides which rows.
      const wGenerics = `<TFilter extends Partial<${rowType}>, TColumns extends ColumnsOf<'${tableName}'> | undefined = undefined>`;
      const wFilter = `filter: RowFilter<'${tableName}', TFilter>`;
      const wOptions = `options?: { columns?: TColumns }`;
      const wRow = `SelectedRow<'${tableName}', TColumns>`;
      const guard = (method: string) => `requireFilter(filter, '${tableName}.${method}')`;
      lines.push(`      // Updates the row matching \`filter\` (a unique column) and returns it in one`);
      lines.push(`      // round trip; error NOT_FOUND_OR_DENIED when no row was changed. More than`);
      lines.push(`      // one match is an error (PGRST116) and nothing is updated.`);
      lines.push(`      updateOne: ${wGenerics}(`);
      lines.push(`        ${wFilter},`);
      lines.push(`        data: ${updateType},`);
      lines.push(`        ${wOptions},`);
      lines.push(`      ) => {`);
      lines.push(`        const match = ${guard('updateOne')};`);
      lines.push(`        return changedOne('${tableName}', 'updateOne', { filter: match }, ${from}.update(data).match(match)${live}.select(selectClause(options?.columns)).maybeSingle()) as unknown as QueryResult<${wRow}>;`);
      lines.push(`      },`);
      lines.push('');
      lines.push(`      // Updates every row matching \`filter\` (at least one column) and returns them.`);
      lines.push(`      updateMany: ${wGenerics}(`);
      lines.push(`        ${wFilter},`);
      lines.push(`        data: ${updateType},`);
      lines.push(`        ${wOptions},`);
      lines.push(`      ) => {`);
      lines.push(`        const match = ${guard('updateMany')};`);
      lines.push(`        return ${from}.update(data).match(match)${live}.select(selectClause(options?.columns)) as unknown as QueryResult<${wRow}[]>;`);
      lines.push(`      },`);
      lines.push('');
      lines.push(`      // Deletes the row matching \`filter\` and returns it; error NOT_FOUND_OR_DENIED`);
      lines.push(`      // when nothing was deleted. More than one match is an error (PGRST116).`);
      lines.push(`      deleteOne: ${wGenerics}(`);
      lines.push(`        ${wFilter},`);
      lines.push(`        ${wOptions},`);
      lines.push(`      ) => {`);
      lines.push(`        const match = ${guard('deleteOne')};`);
      if (softDeleteColumn) {
        lines.push(`        return softDeleted('${tableName}', 'deleteOne', { filter: match },`);
        lines.push(`          () => ${from}.select(selectClause(options?.columns)).match(match)${live}.maybeSingle(),`);
        lines.push(`          () => ${from}.delete().match(match)${live},`);
        lines.push(`          () => ${from}.select('${pk}').match(match)${live}.maybeSingle(),`);
        lines.push(`        ) as unknown as QueryResult<${wRow}>;`);
      } else {
        lines.push(`        return changedOne('${tableName}', 'deleteOne', { filter: match }, ${from}.delete().match(match)${live}.select(selectClause(options?.columns)).maybeSingle()) as unknown as QueryResult<${wRow}>;`);
      }
      lines.push(`      },`);
      lines.push('');
      lines.push(`      // Deletes every row matching \`filter\` (at least one column) and returns them${softDeleteColumn ? ' (\`[]\` on this soft-delete table)' : ''}.`);
      lines.push(`      deleteMany: ${wGenerics}(`);
      lines.push(`        ${wFilter},`);
      lines.push(`        ${wOptions},`);
      lines.push(`      ) => {`);
      lines.push(`        const match = ${guard('deleteMany')};`);
      lines.push(`        return ${from}.delete().match(match)${live}.select(selectClause(options?.columns)) as unknown as QueryResult<${wRow}[]>;`);
      lines.push(`      },`);
      if (tableDef.realtime) {
        lines.push('');
        lines.push(`      // Row changes over Supabase Realtime (Postgres Changes), only for rows the`);
        lines.push(`      // SELECT policy shows. DELETE events are not RLS-filtered and carry only the`);
        lines.push(`      // primary key. Returns a function that unsubscribes.`);
        lines.push(`      subscribe: <TEvent extends RealtimeEvent = '*'>(`);
        lines.push(`        listener: (change: RealtimeChangeOf<RowOf<'${tableName}'>, TEvent>) => void,`);
        lines.push(`        options?: RealtimeSubscribeOptions<RowOf<'${tableName}'>, TEvent>,`);
        lines.push(`      ) =>`);
        lines.push(`        realtimeSubscribe(provider, '${this.options.schemaName}', '${tableName}', listener as (change: unknown) => void, options),`);
      }
      lines.push(`    },`);
      lines.push('');
    }

    if (rpcEntries.length > 0) {
      lines.push(`    rpc: {`);
      for (const [name, def] of rpcEntries) {
        const noArgs = mode === 'manual' && !(def.args && Object.keys(def.args).length > 0);
        // No arguments (manual mode): callable as `client.rpc.<name>()`.
        lines.push(`      ${name}: (args: Functions['${name}']['Args']${noArgs ? ' = {}' : ''}) =>`);
        lines.push(`        provider.rpc('${name}', args) as unknown as QueryResult<Functions['${name}']['Returns']>,`);
        lines.push('');
      }
      lines.push(`    },`);
      lines.push('');
    }

    if (channels.length > 0) {
      lines.push(`    // Private Realtime channels (Broadcast / Presence). Who may join, receive`);
      lines.push(`    // and send is decided by the realtime.messages policies of the schema.`);
      lines.push(`    channels: {`);
      for (const [channelName, def] of channels) {
        const topic = parseChannelTopic(def.topic);
        if (topic.param) {
          const arg = JS_RESERVED.has(topic.param) ? `${topic.param}_` : topic.param;
          lines.push(`      ${channelName}: (${arg}: string) =>`);
          lines.push(`        openChannel(provider, ${quoteTsString(topic.prefix)} + ${arg}) as ChannelOf<TClient>,`);
        } else {
          lines.push(`      ${channelName}: () =>`);
          lines.push(`        openChannel(provider, ${quoteTsString(topic.prefix)}) as ChannelOf<TClient>,`);
        }
      }
      lines.push(`    },`);
      lines.push('');
    }

    if (edgeFunctions.length > 0) {
      lines.push(`    // Edge Functions declared in the schema (POST, JSON). Errors come back in`);
      lines.push(`    // \`error\` (supabase-js FunctionsHttpError: \`await error.context.json()\` is`);
      lines.push(`    // \`{ error: { code, message, issues? } }\`).`);
      lines.push(`    functions: {`);
      for (const [name, def] of edgeFunctions) {
        const fn = edgeFunctionIdentifier(name);
        const type = edgeFunctionTypeName(name);
        const noInput = Object.keys(def.input ?? {}).length === 0;
        const param = def.input === undefined ? `input?: ${type}Input` : `input: ${type}Input${noInput ? ' = {}' : ''}`;
        lines.push(`      ${fn}: (${param}, options?: FunctionInvokeOptions) =>`);
        lines.push(`        invokeFunction(provider, ${quoteTsString(name)}, input, options) as unknown as QueryResult<${type}Output>,`);
      }
      lines.push(`    },`);
      lines.push('');
    }

    lines.push(`  };`);
    lines.push(`}`);
    lines.push('');
    lines.push(`/**`);
    lines.push(` * Type of a client from \`createAccessNexusClient\`. Pass your Supabase client type`);
    lines.push(` * to keep \`auth\` typed: \`AccessNexusClient<SupabaseClient<Database>>\`.`);
    lines.push(` */`);
    lines.push(`export type AccessNexusClient<TClient extends AccessNexusProvider = AccessNexusProvider> =`);
    lines.push(`  ReturnType<typeof createAccessNexusClient<TClient>>;`);
  }

  /** Edge Function input/output types and the invoke helper of the generated client. */
  private edgeFunctionClientHelpers(functions: Array<[string, EdgeFunctionDef]>): string[] {
    const types: string[] = [];
    for (const [name, def] of functions) {
      types.push(`/** Edge Function \`${name}\`. */`);
      types.push(...this.edgeFunctionTypes(def, edgeFunctionTypeName(name), 'FunctionJson', 'client'));
    }
    const out: string[] = [
      ...(types.some((line) => line.includes('FunctionJson'))
        ? [`type FunctionJson = string | number | boolean | null | { [key: string]: FunctionJson | undefined } | FunctionJson[];`]
        : []),
      `/** Options of \`client.functions.*\`: extra headers, or a region (e.g. 'us-east-1'). */`,
      `export type FunctionInvokeOptions = { headers?: Record<string, string>; region?: string };`,
      '',
      ...types,
    ];
    out.push(
      '',
      `function invokeFunction(provider: AccessNexusTransport, name: string, body: unknown, options?: FunctionInvokeOptions): PromiseLike<unknown> {`,
      `  if (!provider.functions || typeof provider.functions.invoke !== 'function') {`,
      `    throw new Error(\`[AccessNexus] functions.\${name} needs a Supabase client with Edge Functions (functions.invoke)\`);`,
      `  }`,
      `  return provider.functions.invoke(name, { ...options, body, method: 'POST' });`,
      `}`,
      '',
    );
    return out;
  }

  /** Shared Realtime types and runtime helpers of the generated client. */
  private realtimeClientHelpers(tables: boolean, channels: boolean): string[] {
    const out: string[] = [];
    out.push(
      `function realtimeTransport(provider: AccessNexusTransport, what: string): Required<Pick<AccessNexusTransport, 'channel' | 'removeChannel'>> {`,
      `  if (typeof provider.channel !== 'function' || typeof provider.removeChannel !== 'function') {`,
      `    throw new Error(\`[AccessNexus] \${what} needs a Supabase client with Realtime (channel / removeChannel)\`);`,
      `  }`,
      `  return provider as Required<Pick<AccessNexusTransport, 'channel' | 'removeChannel'>>;`,
      `}`,
      '',
    );
    if (tables) {
      out.push(
        `/** Postgres Changes event to listen to. */`,
        `export type RealtimeEvent = 'INSERT' | 'UPDATE' | 'DELETE' | '*';`,
        `type RealtimeMeta = { schema: string; table: string; commit_timestamp: string; errors: string[] | null };`,
        `/**`,
        ` * One row change. \`old\` holds only the primary key (RLS tables send no more);`,
        ` * DELETE has no \`new\` row.`,
        ` */`,
        `export type RealtimeChange<Row> =`,
        `  | (RealtimeMeta & { eventType: 'INSERT'; new: Row; old: Record<string, never> })`,
        `  | (RealtimeMeta & { eventType: 'UPDATE'; new: Row; old: Partial<Row> })`,
        `  | (RealtimeMeta & { eventType: 'DELETE'; new: Record<string, never>; old: Partial<Row> });`,
        `/** The change type of \`subscribe\`, narrowed by its \`event\` option. */`,
        `export type RealtimeChangeOf<Row, TEvent extends RealtimeEvent> =`,
        `  TEvent extends '*' ? RealtimeChange<Row> : Extract<RealtimeChange<Row>, { eventType: TEvent }>;`,
        `type RealtimeFilterValue<V> = V | readonly V[] | { eq: V } | { neq: V } | { lt: V } | { lte: V } | { gt: V } | { gte: V } | { in: readonly V[] };`,
        `/**`,
        ` * Server-side filter of \`subscribe\`: exactly one column (Realtime accepts one),`,
        ` * \`{ project_id: id }\`, \`{ status: ['todo', 'done'] }\` (in) or \`{ views: { gt: 10 } }\`.`,
        ` * DELETE events ignore filters.`,
        ` */`,
        `export type RealtimeFilter<Row> = { [K in keyof Row]?: RealtimeFilterValue<NonNullable<Row[K]>> };`,
        `/** Options of \`subscribe\`. */`,
        `export type RealtimeSubscribeOptions<Row, TEvent extends RealtimeEvent = '*'> = {`,
        `  event?: TEvent;`,
        `  filter?: RealtimeFilter<Row>;`,
        `  /** Channel status: SUBSCRIBED, CHANNEL_ERROR, TIMED_OUT or CLOSED. */`,
        `  onStatus?: (status: string, error?: Error) => void;`,
        `};`,
        '',
        `const REALTIME_OPS = new Set(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in']);`,
        '',
        `function realtimeFilter(filter: object | undefined): string | undefined {`,
        `  const entries = Object.entries(filter ?? {}).filter(([, value]) => value !== undefined);`,
        `  if (entries.length === 0) return undefined;`,
        `  if (entries.length > 1) {`,
        `    throw new Error('[AccessNexus] subscribe: Realtime filters on one column only');`,
        `  }`,
        `  const [column, value] = entries[0];`,
        `  if (value === null) throw new Error(\`[AccessNexus] subscribe: cannot filter \${column} on null\`);`,
        `  if (Array.isArray(value)) return \`\${column}=in.(\${value.map(String).join(',')})\`;`,
        `  if (typeof value === 'object') {`,
        `    const ops = Object.entries(value as Record<string, unknown>);`,
        `    if (ops.length === 1 && REALTIME_OPS.has(ops[0][0])) {`,
        `      const [op, operand] = ops[0];`,
        `      return Array.isArray(operand) ? \`\${column}=\${op}.(\${operand.map(String).join(',')})\` : \`\${column}=\${op}.\${String(operand)}\`;`,
        `    }`,
        `  }`,
        `  return \`\${column}=eq.\${String(value)}\`;`,
        `}`,
        '',
        `let realtimeSeq = 0;`,
        '',
        `function realtimeSubscribe(`,
        `  provider: AccessNexusTransport,`,
        `  schema: string,`,
        `  table: string,`,
        `  listener: (change: unknown) => void,`,
        `  options?: { event?: string; filter?: object; onStatus?: (status: string, error?: Error) => void },`,
        `): () => void {`,
        `  const realtime = realtimeTransport(provider, \`\${table}.subscribe\`);`,
        `  const filter = realtimeFilter(options?.filter);`,
        `  realtimeSeq += 1;`,
        `  const channel = realtime.channel(\`accessnexus:\${table}:\${realtimeSeq}\`);`,
        `  channel`,
        `    .on('postgres_changes', { event: options?.event ?? '*', schema, table, ...(filter ? { filter } : {}) }, listener)`,
        `    .subscribe(options?.onStatus);`,
        `  return () => {`,
        `    void realtime.removeChannel(channel);`,
        `  };`,
        `}`,
        '',
      );
    }
    if (channels) {
      out.push(
        `/** The provider's own RealtimeChannel type (unknown for a bare AccessNexusProvider). */`,
        `export type ChannelOf<TClient extends AccessNexusProvider> =`,
        `  TClient['channel'] extends ((...args: never[]) => infer C) | undefined ? C : unknown;`,
        '',
        `function openChannel(provider: AccessNexusTransport, topic: string): RealtimeChannelLike {`,
        `  // Private: Realtime checks the realtime.messages policies on join, send and receive.`,
        `  return realtimeTransport(provider, \`channel \${topic}\`).channel(topic, { config: { private: true } });`,
        `}`,
        '',
      );
    }
    return out;
  }

  // ---- TypeScript Generation (manual mode) ----

  private columnTypeToTS(colType: string): string {
    const base = colType.endsWith('?') ? colType.slice(0, -1) : colType;
    const nullable = colType.endsWith('?');
    if (base.startsWith('enum:')) {
      const values = this.namedEnums[base.slice(5)];
      const union = values && values.length > 0 ? values.map((v) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(' | ') : 'string';
      return nullable ? `${union} | null` : union;
    }
    const ref = this.resolveColumnRef(base);
    if (ref) return nullable ? `${ref.ts} | null` : ref.ts;

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
      json: 'Json',
      jsonb: 'Json',
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

    const usedNames: string[] = [];
    explicit.forEach((index) => {
      const unique = index.unique ? 'UNIQUE ' : '';
      // Named from the content only (reordering `indexes` changes nothing); _2... on a clash.
      const base = `idx_${tableName}_${index.columns.join('_')}${index.unique ? '_uniq' : ''}`;
      let indexName = index.name ?? base;
      for (let n = 2; !index.name && usedNames.includes(indexName); n++) indexName = `${base}_${n}`;
      usedNames.push(indexName);
      const signature = `${index.unique ? 'u' : 'n'}|${index.columns.join(',')}`;
      seenSignatures.add(signature);
      output.push(`CREATE ${unique}INDEX IF NOT EXISTS ${indexName} ON ${tableName}(${index.columns.join(', ')});`);
    });

    for (const fkColumn of fkColumns) {
      const signature = `n|${fkColumn}`;
      if (seenSignatures.has(signature)) continue;
      // A declared index that starts with the column already serves the foreign key.
      if (explicit.some((index) => index.columns[0] === fkColumn)) continue;
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
      if (explicit.some((index) => index.columns[0] === col)) continue;
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
        const kindName = belongsToRule.kind === 'shares_tenant' ? 'shares_tenant' : 'belongs_to';
        const fnName = `${this.options.policyPrefix}_${tableName}_${kindName}_${helperCount}_fn`;
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
    if (rule.kind === 'belongs_to' || rule.kind === 'shares_tenant') return [rule];
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
        case 'shares_tenant':
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
    if (rule.kind === 'shares_tenant') {
      return `shares|${r.column}|${r.membership.table}|${r.membership.userColumn}|${r.membership.tenantColumn}`;
    }
    const through = r.through
      ? `${r.through.table}|${r.through.foreignKey}|${r.through.localKey}`
      : '';
    const where = r.through?.where ? `|${JSON.stringify(r.through.where)}` : '';
    return `${r.column}|${through}${where}`;
  }

  private belongsToRuleToHelperSQL(fnName: string, rule: any): string {
    const qualifyTable = (table: string) =>
      table.includes('.') ? table : `${this.options.schemaName}.${table}`;

    if (rule.kind === 'shares_tenant') {
      const m = rule.membership;
      return [
        `CREATE OR REPLACE FUNCTION ${fnName}(p_value uuid)`,
        `RETURNS boolean`,
        `LANGUAGE sql`,
        `STABLE`,
        `SECURITY DEFINER`,
        this.functionSearchPathClause(),
        `AS $$`,
        `  SELECT EXISTS (`,
        `    SELECT 1 FROM ${qualifyTable(m.table)} me`,
        `    JOIN ${qualifyTable(m.table)} them ON them.${m.tenantColumn} = me.${m.tenantColumn}`,
        `    WHERE me.${m.userColumn} = (SELECT auth.uid()) AND them.${m.userColumn} = p_value`,
        `  );`,
        `$$;`,
      ].join('\n');
    }

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
      '// Same definition as the `Json` type `supabase gen types` emits, so json/jsonb',
      '// columns are interchangeable with Supabase-generated types.',
      'export type Json =',
      '  | string',
      '  | number',
      '  | boolean',
      '  | null',
      '  | { [key: string]: Json | undefined }',
      '  | Json[];',
      '',
    ];

    for (const [tableName, tableDef] of Object.entries(schema)) {
      const interfaceName = this.toPascalCase(tableName);

      // A type alias (not an interface) so rows get an implicit index signature
      // and satisfy supabase-js' `GenericTable` (`Row: Record<string, unknown>`).
      lines.push(`export type ${interfaceName} = {`);

      for (const [colName, colDef] of Object.entries(tableDef.columns)) {
        const colType = typeof colDef === 'string' ? colDef : colDef.type;
        const tsType = this.columnTypeToTS(colType);
        lines.push(`  ${colName}: ${tsType};`);
      }

      lines.push(`};`);
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
      const returnsType = this.rpcReturnsToTS(schema, def.returns);
      lines.push(`      ${name}: {`);
      lines.push(`        Args: ${argsType};`);
      lines.push(`        Returns: ${returnsType};`);
      lines.push(`      };`);
    }
    lines.push(`    };`);
    // Shared enums (defineEnum), shaped like `supabase gen types`.
    const namedEnums = Object.entries(this.namedEnums);
    if (namedEnums.length === 0) {
      lines.push(`    Enums: Record<string, never>;`);
    } else {
      lines.push(`    Enums: {`);
      for (const [name] of namedEnums) lines.push(`      ${name}: ${this.columnTypeToTS(`enum:${name}`)};`);
      lines.push(`    };`);
    }
    lines.push(`    CompositeTypes: Record<string, never>;`);
    lines.push(`  };`);
    lines.push(`}`);
    lines.push('');

    return lines.join('\n');
  }

  private generateClientCode(schema: SchemaDef): string {
    const lines: string[] = [
      '// ============================================',
      '// AccessNexus: Auto-generated client',
      '// DO NOT EDIT — regenerate with `npx accessnexus generate`',
      '// ============================================',
      '',
    ];

    const typeImports: string[] = [];
    for (const tableName of Object.keys(schema)) {
      const name = this.toPascalCase(tableName);
      typeImports.push(name, `${name}Create`, `${name}Update`);
    }
    lines.push(`import type { Database, ${typeImports.join(', ')} } from './types.js';`);
    lines.push(`export type { Json } from './types.js';`);
    this.emitClientBody(schema, lines, 'manual');
    return lines.join('\n');
  }

  // ---- Edge Functions ----

  /**
   * Edge Function files, relative to the functions folder (default
   * `supabase/functions`): `_shared/accessnexus.ts` (typed, validated wrappers
   * around `withSupabase` from `@supabase/server`; derived) and one
   * `<name>/index.ts` scaffold per function (`overwrite: false`: written only
   * when missing, then yours). Empty when the schema declares no `functions`.
   */
  generateEdgeFunctions(schema: SchemaDef): GeneratedOutput[] {
    this.useSchema(schema);
    const functions = edgeFunctionsOf(schema);
    if (functions === undefined) return [];
    const entries = Object.entries(functions);
    const L: string[] = [
      '// ============================================',
      '// AccessNexus: Auto-generated Edge Function wrappers',
      '// DO NOT EDIT — regenerate with `npx accessnexus generate`',
      '// Runs on Supabase Edge Functions (Deno) with @supabase/server.',
      '// ============================================',
      '',
      `import { withSupabase, type SupabaseContext } from 'npm:@supabase/server@1';`,
      '',
      `export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];`,
      '',
      `/** Throw from a handler to answer with this HTTP status and \`{ error: { code, message } }\`. */`,
      `export class FunctionError extends Error {`,
      `  constructor(readonly status: number, readonly code: string, message: string) {`,
      `    super(message);`,
      `    this.name = 'FunctionError';`,
      `  }`,
      `}`,
      '',
      `/** What a handler receives besides its input: the @supabase/server context. */`,
      `export type FunctionContext = SupabaseContext;`,
      `type Handler<I, O> = (input: I, ctx: FunctionContext, req: Request) => O | Response | Promise<O | Response>;`,
      `type Field = { type: string; optional: boolean; values?: readonly string[]; maxLength?: number };`,
      `type Issue = { field: string; message: string };`,
      '',
      `const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;`,
      `const DATE = /^\\d{4}-\\d{2}-\\d{2}$/;`,
      `const TIME = /^\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?$/;`,
      '',
      `function validValue(field: Field, value: unknown): boolean {`,
      `  switch (field.type) {`,
      `    case 'uuid': return typeof value === 'string' && UUID.test(value);`,
      `    case 'text': return typeof value === 'string';`,
      `    case 'varchar': return typeof value === 'string' && (field.maxLength === undefined || value.length <= field.maxLength);`,
      `    case 'int': case 'smallint': case 'bigint': case 'serial': return Number.isSafeInteger(value);`,
      `    case 'float': case 'decimal': case 'numeric': return typeof value === 'number' && Number.isFinite(value);`,
      `    case 'boolean': return typeof value === 'boolean';`,
      `    case 'json': case 'jsonb': return value !== undefined;`,
      `    case 'date': return typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(value));`,
      `    case 'timestamp': case 'timestamptz': return typeof value === 'string' && !Number.isNaN(Date.parse(value));`,
      `    case 'time': return typeof value === 'string' && TIME.test(value);`,
      `    case 'enum': return typeof value === 'string' && (field.values ?? []).includes(value);`,
      `    case 'text[]': return Array.isArray(value) && value.every((v) => typeof v === 'string');`,
      `    case 'int[]': return Array.isArray(value) && value.every((v) => Number.isSafeInteger(v));`,
      `    case 'uuid[]': return Array.isArray(value) && value.every((v) => typeof v === 'string' && UUID.test(v));`,
      `    default: return false;`,
      `  }`,
      `}`,
      '',
      `function validate(spec: Record<string, Field>, body: unknown): Issue[] {`,
      `  if (body === null || typeof body !== 'object' || Array.isArray(body)) {`,
      `    return [{ field: '(body)', message: 'expected a JSON object' }];`,
      `  }`,
      `  const issues: Issue[] = [];`,
      `  const record = body as Record<string, unknown>;`,
      `  for (const key of Object.keys(record)) {`,
      `    if (!Object.hasOwn(spec, key)) issues.push({ field: key, message: 'unknown field' });`,
      `  }`,
      `  for (const [key, field] of Object.entries(spec)) {`,
      `    const value = record[key];`,
      `    if (value === undefined || value === null) {`,
      `      if (!field.optional) issues.push({ field: key, message: value === null ? 'must not be null' : 'is required' });`,
      `      continue;`,
      `    }`,
      `    if (!validValue(field, value)) {`,
      `      issues.push({ field: key, message: field.values ? \`must be one of: \${field.values.join(', ')}\` : \`must be \${field.type}\` });`,
      `    }`,
      `  }`,
      `  return issues;`,
      `}`,
      '',
      `function errorResponse(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {`,
      `  return Response.json({ error: { code, message, ...extra } }, { status });`,
      `}`,
      '',
      `// With an input spec: POST + JSON body, validated before the handler runs.`,
      `// Without one (\`input\` omitted): the body is left unread for the handler (e.g. a`,
      `// webhook verifying a signature over the raw body), and \`input\` is undefined.`,
      `async function run<I, O>(req: Request, ctx: FunctionContext, spec: Record<string, Field> | null, handler: Handler<I, O>): Promise<Response> {`,
      `  let body: unknown = undefined;`,
      `  if (spec) {`,
      `    if (req.method !== 'POST') return errorResponse(405, 'method_not_allowed', 'Use POST with a JSON body');`,
      `    const text = await req.text();`,
      `    body = {};`,
      `    if (text.trim() !== '') {`,
      `      try {`,
      `        body = JSON.parse(text);`,
      `      } catch {`,
      `        return errorResponse(400, 'invalid_json', 'The request body is not valid JSON');`,
      `      }`,
      `    }`,
      `    const issues = validate(spec, body);`,
      `    if (issues.length > 0) return errorResponse(400, 'invalid_input', 'The request body does not match the function input', { issues });`,
      `  }`,
      `  try {`,
      `    const result = await handler(body as I, ctx, req);`,
      `    if (result instanceof Response) return result;`,
      `    return result === undefined ? new Response(null, { status: 204 }) : Response.json(result);`,
      `  } catch (err) {`,
      `    if (err instanceof FunctionError) return errorResponse(err.status, err.code, err.message);`,
      `    console.error(err);`,
      `    return errorResponse(500, 'internal_error', 'Internal error');`,
      `  }`,
      `}`,
      '',
    ];
    const outputs: GeneratedOutput[] = [];
    for (const [name, def] of entries) {
      const fn = edgeFunctionIdentifier(name);
      const type = edgeFunctionTypeName(name);
      const auth = edgeFunctionAuthList(def);
      const authLiteral = auth.length === 1 ? quoteTsString(auth[0]) : `[${auth.map(quoteTsString).join(', ')}]`;
      const specConst = `${name.replace(/[-]/g, '_').toUpperCase()}_INPUT`;
      L.push(`// ---- ${name} ----`);
      L.push('');
      L.push(...this.edgeFunctionTypes(def, type, 'Json', 'server'));
      const fields = Object.entries(def.input ?? {});
      if (def.input === undefined) {
        L.push(`const ${specConst} = null;`);
      } else if (fields.length === 0) {
        L.push(`const ${specConst}: Record<string, Field> = {};`);
      } else {
        L.push(`const ${specConst}: Record<string, Field> = {`);
        for (const [field, colType] of fields) {
          L.push(`  ${field}: ${edgeFieldSpec(colType, this.namedEnums)},`);
        }
        L.push(`};`);
      }
      L.push('');
      L.push(`/**`);
      L.push(def.input === undefined
        ? ` * \`${name}\` (auth: ${auth.join(', ')}). No input spec: the body is left for you to read`
        : ` * \`${name}\` (auth: ${auth.join(', ')}). Validates the JSON body as ${type}Input,`);
      L.push(` * then calls \`handler(input, ctx, req)\`: \`ctx.supabase\` runs as the caller (RLS),`);
      L.push(` * \`ctx.supabaseAdmin\` bypasses RLS. Return ${type}Output (or a Response), or throw FunctionError.`);
      L.push(` */`);
      L.push(`export function ${fn}(handler: Handler<${type}Input, ${type}Output>): (req: Request) => Promise<Response> {`);
      L.push(`  return withSupabase({ auth: ${authLiteral} }, (req, ctx) => run(req, ctx, ${specConst}, handler));`);
      L.push(`}`);
      L.push('');

      const userOnly = auth.every((a) => a === 'user');
      outputs.push({
        path: `${name}/index.ts`,
        overwrite: false,
        content: [
          `// Edge Function \`${name}\`: scaffolded once by AccessNexus — this file is yours.`,
          `// The wrapper from _shared/accessnexus.ts (regenerated from the schema) checks auth`,
          `// (${auth.join(', ')}), answers CORS, and validates the JSON body before calling you.`,
          `// ctx.supabase runs as the caller, so RLS applies.${userOnly ? '' : ' Without a user (publishable/secret/none) it has no user.'}`,
          `// ctx.supabaseAdmin bypasses RLS: filter by ctx.userClaims yourself if you use it.`,
          ...(def.input === undefined
            ? [`// No input spec: read the body yourself (await req.text()), e.g. to verify a webhook signature.`]
            : []),
          `import { FunctionError, ${fn} } from '../_shared/accessnexus.ts';`,
          '',
          `export default {`,
          `  // Handler: (input, ctx, req) => output. Return the output, or throw FunctionError.`,
          `  fetch: ${fn}(async () => {`,
          `    throw new FunctionError(501, 'not_implemented', '${name} is not implemented yet');`,
          `  }),`,
          `};`,
          '',
        ].join('\n'),
      });
    }
    return [{ path: '_shared/accessnexus.ts', content: `${L.join('\n').trimEnd()}\n` }, ...outputs];
  }

  /**
   * The `[functions.<name>]` tables AccessNexus manages in `supabase/config.toml`
   * (`verify_jwt = false` only for functions that accept `auth: 'none'`). `null`
   * when the schema declares no `functions`.
   */
  edgeFunctionsConfigToml(schema: SchemaDef): Array<{ name: string; verifyJwt: boolean }> | null {
    const functions = edgeFunctionsOf(schema);
    if (functions === undefined) return null;
    return Object.entries(functions).map(([name, def]) => ({
      name,
      verifyJwt: !edgeFunctionAuthList(def).includes('none'),
    }));
  }

  /**
   * `<Type>Input` / `<Type>Output` declarations of one Edge Function. Without an
   * input spec the server handler gets `undefined` (it reads the request) and the
   * client may send any JSON.
   */
  private edgeFunctionTypes(def: EdgeFunctionDef, type: string, json: string, side: 'server' | 'client'): string[] {
    const field = (colType: string) => this.edgeFieldTS(colType, json);
    const out: string[] = [];
    const input = Object.entries(def.input ?? {});
    if (def.input === undefined) {
      out.push(`export type ${type}Input = ${side === 'server' ? 'undefined' : `${json} | undefined`};`);
    } else if (input.length === 0) {
      out.push(`export type ${type}Input = Record<string, never>;`);
    } else {
      out.push(`export type ${type}Input = {`);
      for (const [name, colType] of input) {
        const optional = colType.endsWith('?');
        out.push(`  ${name}${optional ? '?' : ''}: ${field(colType)};`);
      }
      out.push(`};`);
    }
    if (def.output === undefined) {
      out.push(`export type ${type}Output = unknown;`);
    } else if (typeof def.output === 'string') {
      out.push(`export type ${type}Output = ${def.output === 'void' ? 'void' : field(def.output)};`);
    } else {
      out.push(`export type ${type}Output = {`);
      for (const [name, colType] of Object.entries(def.output)) {
        out.push(`  ${name}: ${field(colType)};`);
      }
      out.push(`};`);
    }
    return out;
  }

  private edgeFieldTS(colType: string, json: string): string {
    const base = colType.endsWith('?') ? colType.slice(0, -1) : colType;
    if (/^varchar\(\d+\)$/.test(base)) return colType.endsWith('?') ? 'string | null' : 'string';
    return this.columnTypeToTS(colType).replace(/\bJson\b/g, json);
  }

  // ---- TanStack Query helpers (adapterOptions.reactQuery) ----

  /**
   * `react-query.ts`: query keys, `queryOptions` for every read and mutation
   * options for every write/RPC, all wrapping the generated client. Types are
   * taken from `client.ts` (`Parameters<...>` and the client's own generics),
   * so the file is identical in manual and Database mode.
   */
  private generateReactQueryCode(schema: SchemaDef): string {
    const rpcs = (schema as any).__rpcs as Record<string, RpcDef> | undefined;
    const rpcNames = rpcs ? Object.keys(rpcs) : [];
    const tables = Object.keys(schema);
    const edgeFns = Object.entries(edgeFunctionsOf(schema) ?? {});

    // Tables whose queries may embed `table` through `include` (they reference it).
    const embeddedIn = new Map<string, string[]>();
    for (const tableName of tables) {
      for (const relation of this.getTableRelations(schema, tableName)) {
        const list = embeddedIn.get(relation.targetTable) ?? [];
        if (!list.includes(tableName) && relation.targetTable !== tableName) list.push(tableName);
        embeddedIn.set(relation.targetTable, list);
      }
    }

    const includeTypes = tables
      .filter((t) => this.getTableRelations(schema, t).length > 0)
      .map((t) => `${this.toPascalCase(t)}Include`);

    const lines: string[] = [
      '// ============================================',
      '// AccessNexus: Auto-generated TanStack Query helpers',
      '// Requires @tanstack/react-query v5',
      '// DO NOT EDIT — regenerate with `npx accessnexus generate`',
      '// ============================================',
      '',
      `import { queryOptions, type QueryClient } from '@tanstack/react-query';`,
      `import type { AccessNexusClient, AccessNexusProvider, ColumnsOf${includeTypes.map((t) => `, ${t}`).join('')} } from './client.js';`,
      '',
      `type Client = AccessNexusClient;`,
      `type TableKey = Exclude<keyof Client, 'auth' | 'rpc' | 'channels' | 'functions'>;`,
      `type FilterOf<K extends TableKey> = NonNullable<Parameters<Client[K]['findMany']>[0]>;`,
      `type CreateOf<K extends TableKey> = Parameters<Client[K]['create']>[0];`,
      `type UpdateOf<K extends TableKey> = Parameters<Client[K]['update']>[1];`,
      `type Result<T> = PromiseLike<{ data: T | null; error: unknown }>;`,
      '',
      `// Supabase reports failures in \`error\`; TanStack Query needs a rejection.`,
      `// The thrown value is the Supabase error itself (PostgrestError: code, message, details).`,
      `async function unwrap<T>(result: Result<T>): Promise<T | null> {`,
      `  const { data, error } = await result;`,
      `  if (error) throw error;`,
      `  return data;`,
      `}`,
      `async function unwrapList<T>(result: Result<T[]>): Promise<T[]> {`,
      `  return (await unwrap(result)) ?? [];`,
      `}`,
      `async function unwrapRow<T>(result: Result<T>): Promise<T> {`,
      `  // create/update use .single(): no row is reported as an error, never as null.`,
      `  return (await unwrap(result)) as T;`,
      `}`,
      '',
      `/**`,
      ` * Query keys of the helpers below. Every key starts with \`['accessnexus', <table>]\`,`,
      ` * so \`invalidateQueries({ queryKey: accessNexusKeys.<table>.all })\` refreshes a table.`,
      ` */`,
      `export const accessNexusKeys = {`,
      `  all: ['accessnexus'] as const,`,
    ];
    for (const t of tables) {
      lines.push(
        `  ${t}: {`,
        `    all: ['accessnexus', '${t}'] as const,`,
        `    list: (filter?: unknown, options?: unknown) => ['accessnexus', '${t}', 'list', { filter: filter ?? {}, options: options ?? {} }] as const,`,
        `    one: (filter: unknown, options?: unknown) => ['accessnexus', '${t}', 'one', { filter, options: options ?? {} }] as const,`,
        `    byId: (id: string, options?: unknown) => ['accessnexus', '${t}', 'byId', id, options ?? {}] as const,`,
        `  },`,
      );
    }
    if (rpcNames.length > 0) {
      lines.push(`  rpc: {`, `    all: ['accessnexus', 'rpc'] as const,`);
      for (const name of rpcNames) {
        lines.push(`    ${name}: (args?: unknown) => ['accessnexus', 'rpc', '${name}', args ?? {}] as const,`);
      }
      lines.push(`  },`);
    }
    if (edgeFns.length > 0) {
      lines.push(`  functions: {`, `    all: ['accessnexus', 'functions'] as const,`);
      for (const [name] of edgeFns) {
        lines.push(`    ${edgeFunctionIdentifier(name)}: (input?: unknown) => ['accessnexus', 'functions', ${quoteTsString(name)}, input ?? {}] as const,`);
      }
      lines.push(`  },`);
    }
    lines.push(
      `};`,
      '',
      `export interface AccessNexusQueriesOptions {`,
      `  /**`,
      `   * When set, each mutation invalidates on success the queries it can change:`,
      `   * its table, the tables that embed it via \`include\`, and every query for an RPC`,
      `   * mutation. Without it, mutations invalidate nothing.`,
      `   */`,
      `  queryClient?: QueryClient;`,
      `}`,
      '',
      `/**`,
      ` * TanStack Query v5 helpers over a client from \`createAccessNexusClient\`:`,
      ` * reads return \`queryOptions\` (\`useQuery(q.tasks.findMany({ project_id }))\`),`,
      ` * writes return mutation options (\`useMutation(q.tasks.create())\`). Spread to add`,
      ` * your own options: \`useQuery({ ...q.tasks.findById(id), enabled: !!id })\`.`,
      ` */`,
      `export function createAccessNexusQueries<TClient extends AccessNexusProvider>(`,
      `  client: AccessNexusClient<TClient>,`,
      `  { queryClient }: AccessNexusQueriesOptions = {},`,
      `) {`,
      `  const invalidate = (...keys: ReadonlyArray<readonly unknown[]>) => async () => {`,
      `    if (!queryClient) return;`,
      `    await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));`,
      `  };`,
      `  return {`,
    );

    for (const t of tables) {
      const hasRel = this.getTableRelations(schema, t).length > 0;
      const inc = `${this.toPascalCase(t)}Include`;
      const generics = hasRel
        ? `<TColumns extends ColumnsOf<'${t}'> | undefined = undefined, TInclude extends ${inc} | undefined = undefined>`
        : `<TColumns extends ColumnsOf<'${t}'> | undefined = undefined>`;
      const optionsType = hasRel ? `{ columns?: TColumns; include?: TInclude }` : `{ columns?: TColumns }`;
      const typeArgs = hasRel ? `<TColumns, TInclude>` : `<TColumns>`;
      // Its own queries, the tables that embed it, and what its triggers write
      // (trigger.custom({ writes: [...] }): e.g. orgs.create also adds an org_members row).
      const triggerWrites = (schema[t].triggers ?? []).flatMap((rule: any) =>
        rule?.kind === 'custom' && Array.isArray(rule.writes) ? (rule.writes as string[]) : []);
      const affected = [...new Set([t, ...(embeddedIn.get(t) ?? []), ...triggerWrites])]
        .filter((x) => x in schema)
        .map((x) => `accessNexusKeys.${x}.all`).join(', ');
      const keys = `accessNexusKeys.${t}`;
      lines.push(
        `    ${t}: {`,
        `      findMany: ${generics}(filter?: FilterOf<'${t}'>, options?: ${optionsType}) =>`,
        `        queryOptions({`,
        `          queryKey: ${keys}.list(filter, options),`,
        `          queryFn: () => unwrapList(client.${t}.findMany${typeArgs}(filter, options)),`,
        `        }),`,
        `      findOne: ${generics}(filter: FilterOf<'${t}'>, options?: ${optionsType}) =>`,
        `        queryOptions({`,
        `          queryKey: ${keys}.one(filter, options),`,
        `          queryFn: () => unwrap(client.${t}.findOne${typeArgs}(filter, options)),`,
        `        }),`,
        `      findById: ${generics}(id: string, options?: ${optionsType}) =>`,
        `        queryOptions({`,
        `          queryKey: ${keys}.byId(id, options),`,
        `          queryFn: () => unwrap(client.${t}.findById${typeArgs}(id, options)),`,
        `        }),`,
        `      create: () => ({`,
        `        mutationKey: [...${keys}.all, 'create'] as const,`,
        `        mutationFn: (data: CreateOf<'${t}'>) => unwrapRow(client.${t}.create(data)),`,
        `        onSuccess: invalidate(${affected}),`,
        `      }),`,
        `      update: () => ({`,
        `        mutationKey: [...${keys}.all, 'update'] as const,`,
        `        mutationFn: ({ id, data }: { id: string; data: UpdateOf<'${t}'> }) => unwrapRow(client.${t}.update(id, data)),`,
        `        onSuccess: invalidate(${affected}),`,
        `      }),`,
        `      delete: () => ({`,
        `        mutationKey: [...${keys}.all, 'delete'] as const,`,
        `        mutationFn: async (id: string) => { await unwrap(client.${t}.delete(id)); },`,
        `        onSuccess: invalidate(${affected}),`,
        `      }),`,
        `      // Filtered writes: an empty filter throws before any request (see client.ts).`,
        `      updateOne: () => ({`,
        `        mutationKey: [...${keys}.all, 'updateOne'] as const,`,
        `        mutationFn: ({ filter, data }: { filter: FilterOf<'${t}'>; data: UpdateOf<'${t}'> }) => unwrap(client.${t}.updateOne(filter, data)),`,
        `        onSuccess: invalidate(${affected}),`,
        `      }),`,
        `      updateMany: () => ({`,
        `        mutationKey: [...${keys}.all, 'updateMany'] as const,`,
        `        mutationFn: ({ filter, data }: { filter: FilterOf<'${t}'>; data: UpdateOf<'${t}'> }) => unwrapList(client.${t}.updateMany(filter, data)),`,
        `        onSuccess: invalidate(${affected}),`,
        `      }),`,
        `      deleteOne: () => ({`,
        `        mutationKey: [...${keys}.all, 'deleteOne'] as const,`,
        `        mutationFn: (filter: FilterOf<'${t}'>) => unwrap(client.${t}.deleteOne(filter)),`,
        `        onSuccess: invalidate(${affected}),`,
        `      }),`,
        `      deleteMany: () => ({`,
        `        mutationKey: [...${keys}.all, 'deleteMany'] as const,`,
        `        mutationFn: (filter: FilterOf<'${t}'>) => unwrapList(client.${t}.deleteMany(filter)),`,
        `        onSuccess: invalidate(${affected}),`,
        `      }),`,
      );
      if (schema[t].realtime) {
        lines.push(
          `      // Keeps queries fresh: on every Realtime change of ${t} (that RLS lets this`,
          `      // user see), invalidates ${t} and the tables that embed it. Call it in an`,
          `      // effect and return its result: useEffect(() => q.${t}.invalidateOnChange(), []).`,
          `      invalidateOnChange: (options?: Parameters<Client['${t}']['subscribe']>[1]) => {`,
          `        if (!queryClient) throw new Error('[AccessNexus] ${t}.invalidateOnChange needs createAccessNexusQueries(client, { queryClient })');`,
          `        const refresh = invalidate(${affected});`,
          `        return client.${t}.subscribe(() => { void refresh(); }, options);`,
          `      },`,
        );
      }
      lines.push(
        `    },`,
        '',
      );
    }

    if (rpcNames.length > 0) {
      lines.push(`    // Each RPC as a query (reads) and as a mutation (writes; invalidates every query).`);
      lines.push(`    rpc: {`);
      for (const name of rpcNames) {
        const params = `Parameters<Client['rpc']['${name}']>`;
        // RETURNS TABLE / SETOF: an empty result is [], never null.
        const returns = rpcs?.[name]?.returns as unknown;
        const isList = !!returns && typeof returns === 'object' && (isTableReturn(returns) || isSetofReturn(returns));
        const unwrapFn = isList ? 'unwrapList' : 'unwrap';
        lines.push(
          `      ${name}: {`,
          `        query: (...args: ${params}) =>`,
          `          queryOptions({`,
          `            queryKey: accessNexusKeys.rpc.${name}(args[0]),`,
          `            queryFn: () => ${unwrapFn}(client.rpc.${name}(...args)),`,
          `          }),`,
          `        mutation: () => ({`,
          `          mutationKey: [...accessNexusKeys.rpc.all, '${name}'] as const,`,
          `          mutationFn: (args: ${params}[0]) => ${unwrapFn}(client.rpc.${name}(args)),`,
          `          onSuccess: invalidate(accessNexusKeys.all),`,
          `        }),`,
          `      },`,
        );
      }
      lines.push(`    },`, '');
    }

    if (edgeFns.length > 0) {
      lines.push(`    // Each Edge Function as a query and as a mutation (invalidates every query).`);
      lines.push(`    functions: {`);
      for (const [name] of edgeFns) {
        const fn = edgeFunctionIdentifier(name);
        const params = `Parameters<Client['functions']['${fn}']>`;
        lines.push(
          `      ${fn}: {`,
          `        query: (...args: ${params}) =>`,
          `          queryOptions({`,
          `            queryKey: accessNexusKeys.functions.${fn}(args[0]),`,
          `            queryFn: () => unwrap(client.functions.${fn}(...args)),`,
          `          }),`,
          `        mutation: () => ({`,
          `          mutationKey: [...accessNexusKeys.functions.all, ${quoteTsString(name)}] as const,`,
          `          mutationFn: (input: ${params}[0]) => unwrap(client.functions.${fn}(input)),`,
          `          onSuccess: invalidate(accessNexusKeys.all),`,
          `        }),`,
          `      },`,
        );
      }
      lines.push(`    },`, '');
    }

    lines.push(
      `  };`,
      `}`,
      '',
      `/** Type of the helpers returned by \`createAccessNexusQueries\`. */`,
      `export type AccessNexusQueries = ReturnType<typeof createAccessNexusQueries>;`,
      '',
    );
    return lines.join('\n');
  }

  private toPascalCase(str: string): string {
    return str
      .split(/[_\-\s]+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join('');
  }
}

function isTableReturn(r: object): r is RpcTableReturn {
  return 'table' in r && typeof (r as RpcTableReturn).table === 'object' && (r as RpcTableReturn).table !== null;
}

function isSetofReturn(r: object): r is RpcSetofReturn {
  return 'setof' in r && typeof (r as RpcSetofReturn).setof === 'string';
}

/** Whether a `setof` target is a column type (otherwise it names a table). */
function isRpcScalarType(t: string): boolean {
  const base = t.endsWith('?') ? t.slice(0, -1) : t;
  return RPC_SCALAR_TYPES.has(base) || /^numeric\(\d+(,\d+)?\)$/.test(base) || /^varchar\(\d+\)$/.test(base);
}

const RPC_SCALAR_TYPES = new Set([
  'uuid', 'text', 'varchar', 'int', 'smallint', 'bigint', 'serial', 'float', 'decimal', 'numeric', 'boolean',
  'json', 'jsonb', 'date', 'timestamp', 'timestamptz', 'time', 'text[]', 'int[]', 'uuid[]',
]);

/** `{ type, default }` for an RPC argument given as a type string or an object. */
function normalizeRpcArg(arg: RpcArg): { type: string; default?: string } {
  return typeof arg === 'string' ? { type: arg } : { type: arg.type, default: arg.default };
}

/**
 * `'project:{id}'` → `{ prefix: 'project:', param: 'id' }`; `'lobby'` →
 * `{ prefix: 'lobby' }`. Validated by `validate` (INVALID_CHANNEL).
 */
export function parseChannelTopic(topic: string): { prefix: string; param?: string } {
  const match = /^([A-Za-z0-9:_.-]*)\{([a-z][a-z0-9_]*)\}$/.exec(topic);
  if (match) return { prefix: match[1], param: match[2] };
  return { prefix: topic };
}

/** A TypeScript single-quoted string literal. */
function quoteTsString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

/** JS/TS words that cannot name a parameter of the generated client. */
const JS_RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
  'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof',
  'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void',
  'while', 'with', 'yield', 'let', 'static', 'implements', 'interface', 'package', 'private', 'protected',
  'public', 'await', 'arguments', 'eval',
]);

/** `defineSchema(..., { functions })`, or undefined when not declared. */
function edgeFunctionsOf(schema: SchemaDef): Record<string, EdgeFunctionDef> | undefined {
  return (schema as any).__functions as Record<string, EdgeFunctionDef> | undefined;
}

/** Allowed auth modes of an Edge Function (default `['user']`). */
export function edgeFunctionAuthList(def: EdgeFunctionDef): EdgeFunctionAuth[] {
  if (def.auth === undefined) return ['user'];
  return typeof def.auth === 'string' ? [def.auth] : [...def.auth];
}

/** `'invite-member'` → `inviteMember` (a reserved word gets a `Function` suffix). */
export function edgeFunctionIdentifier(name: string): string {
  const camel = name.replace(/[-_]+([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  return JS_RESERVED.has(camel) ? `${camel}Function` : camel;
}

/** `'invite-member'` → `InviteMember` (prefix of the Input/Output types). */
function edgeFunctionTypeName(name: string): string {
  const camel = name.replace(/[-_]+([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

/** Runtime validation spec of one input field (a TS object literal). */
function edgeFieldSpec(colType: string, namedEnums: Record<string, readonly string[]> = {}): string {
  const optional = colType.endsWith('?');
  const base = optional ? colType.slice(0, -1) : colType;
  const parts: string[] = [];
  const named = /^enum:(.+)$/.exec(base)?.[1];
  if (named) {
    const values = namedEnums[named] ?? [];
    return `{ type: 'enum', optional: ${optional}, values: [${values.map(quoteTsString).join(', ')}] }`;
  }
  const enumMatch = /^enum\((.*)\)$/.exec(base);
  const varchar = /^varchar\((\d+)\)$/.exec(base);
  if (enumMatch) {
    const values = [...enumMatch[1].matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replaceAll("''", "'"));
    parts.push(`type: 'enum'`, `optional: ${optional}`, `values: [${values.map(quoteTsString).join(', ')}]`);
  } else if (varchar) {
    parts.push(`type: 'varchar'`, `optional: ${optional}`, `maxLength: ${varchar[1]}`);
  } else {
    const type = /^numeric\(\d+(,\d+)?\)$/.test(base) ? 'numeric' : base;
    parts.push(`type: ${quoteTsString(type)}`, `optional: ${optional}`);
  }
  return `{ ${parts.join(', ')} }`;
}

/** The managed block of `supabase/config.toml` (empty list → markers only). */
export const EDGE_FUNCTIONS_TOML_BEGIN = '# >>> accessnexus functions (generated — edit the schema, not this block)';
export const EDGE_FUNCTIONS_TOML_END = '# <<< accessnexus functions';
