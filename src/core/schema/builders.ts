// ============================================
// AccessNexus - Schema Builders
// Developer-facing API for defining schemas
// ============================================

import type { ColumnInput } from '../types/columns.js';
import type { RpcDef } from '../types/rpc.js';
import type { SchemaDef, TableDef } from '../types/schema.js';
import type { SupabaseDatabase, SupabaseSchemaInput } from '../types/supabase.js';

/**
 * Options for defineSchema (second argument).
 */
export interface SchemaOptions {
  /** RPC (PostgreSQL function) definitions */
  rpcs?: Record<string, RpcDef>;
}

/**
 * Define a table (manual mode): columns, primary key, references, policies,
 * triggers, indexes and soft delete. Column types are strings such as `'uuid'`,
 * `'text'`, `'int'`, `'timestamptz'`, `"enum('a','b')"`; append `?` for nullable.
 * Without `policies` the table gets no RLS (public through the Supabase API).
 *
 * @example
 * ```ts
 * const users = table({
 *   columns: {
 *     id: 'uuid',
 *     name: 'text',
 *     email: 'text',
 *   },
 *   primaryKey: 'id',
 *   policies: {
 *     select: policy.isAuthenticated(),
 *   },
 * });
 * ```
 */
export function table<TColumns extends Record<string, ColumnInput>>(
  def: TableDef<TColumns>
): TableDef<TColumns> {
  return withSoftDeleteTrigger({
    enableRLS: def.policies ? true : def.enableRLS,
    ...def,
  });
}

/**
 * Define a complete schema using your Supabase `database.types.ts`.
 * Column definitions are inferred from the Database type — you only
 * need to define policies, indexes, and other AccessNexus config.
 *
 * @example
 * ```ts
 * import type { Database } from './database.types';
 *
 * export default defineSchema<Database>({
 *   profiles: {
 *     policies: { select: policy.isAuthenticated() },
 *   },
 * }, {
 *   rpcs: {
 *     get_stats: rpc(),
 *   },
 * });
 * ```
 */
export function defineSchema<DB extends SupabaseDatabase>(
  tables: SupabaseSchemaInput<DB>,
  options?: SchemaOptions,
): SchemaDef;

/**
 * Define a complete schema manually with explicit column types.
 *
 * @example
 * ```ts
 * export default defineSchema({
 *   users: table({ columns: { id: 'uuid', name: 'text' } }),
 * }, {
 *   rpcs: {
 *     get_stats: rpc({ args: { user_id: 'uuid' }, returns: 'jsonb', body: '...' }),
 *   },
 * });
 * ```
 */
export function defineSchema<T extends SchemaDef>(tables: T, options?: SchemaOptions): T;

// Implementation
export function defineSchema(tables: Record<string, any>, options?: SchemaOptions): any {
  const tableEntries = Object.entries(tables);

  // Detect Supabase Database mode: no table has a `columns` property
  const isSupabaseMode = tableEntries.length > 0 &&
    tableEntries.every(([, def]) => !def.columns);

  let result: any;

  if (isSupabaseMode) {
    result = defineSchemaFromDatabase(tables);
  } else {
    result = defineSchemaManual(tables);
  }

  // Attach RPCs as non-enumerable property (invisible to Object.entries)
  if (options?.rpcs && Object.keys(options.rpcs).length > 0) {
    Object.defineProperty(result, '__rpcs', {
      value: options.rpcs,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  return result;
}

/** Internal: handle schema from Supabase Database types */
function defineSchemaFromDatabase(tables: Record<string, any>): SchemaDef {
  const schema: SchemaDef = {};
  const tableNames = new Set(Object.keys(tables));

  for (const [tableName, def] of Object.entries(tables)) {
    assertIdentifier(tableName, 'table');
    schema[tableName] = withSoftDeleteTrigger({
      columns: {},
      ...def,
      enableRLS: def.policies ? true : def.enableRLS,
    });

    // Validate references (skip column existence since columns come from DB)
    if (def.references) {
      for (const [, ref] of Object.entries(def.references)) {
        if (!ref) continue;

        const parts = (ref as string).split('.');
        if (parts.length < 2 || parts.length > 3) {
          throw new Error(
            `[AccessNexus] Table "${tableName}": invalid reference "${ref}". Expected "table.column" or "schema.table.column"`
          );
        }

        const refTable = parts.length === 3 ? parts[1] : parts[0];
        const isExternalSchema = parts.length === 3;
        if (!isExternalSchema && !tableNames.has(refTable)) {
          throw new Error(
            `[AccessNexus] Table "${tableName}": references table "${refTable}" which is not defined in schema`
          );
        }
      }
    }
  }

  return schema;
}

/** Internal: handle manually-defined schema (original behavior) */
function defineSchemaManual(tables: Record<string, any>): any {
  const tableNames = new Set(Object.keys(tables));

  for (const [tableName, tableDef] of Object.entries(tables)) {
    assertIdentifier(tableName, 'table');
    const normalized = withSoftDeleteTrigger(tableDef);
    tables[tableName] = normalized;

    for (const columnName of Object.keys(normalized.columns ?? {})) {
      assertIdentifier(columnName, `column in "${tableName}"`);
    }

    for (const column of normalized.compositePrimaryKey ?? []) {
      if (!(column in normalized.columns)) {
        throw new Error(
          `[AccessNexus] Table "${tableName}": compositePrimaryKey column "${column}" does not exist in columns`
        );
      }
    }

    if (normalized.primaryKey && !(normalized.primaryKey in normalized.columns)) {
      throw new Error(
        `[AccessNexus] Table "${tableName}": primaryKey "${normalized.primaryKey}" does not exist in columns`
      );
    }

    if (normalized.references) {
      for (const [column, ref] of Object.entries(normalized.references)) {
        if (!ref) continue;

        // Validate column exists
        if (!(column in normalized.columns)) {
          throw new Error(
            `[AccessNexus] Table "${tableName}": reference column "${column}" does not exist in columns`
          );
        }

        // Validate reference format (table.column or schema.table.column)
        const parts = (ref as string).split('.');
        if (parts.length < 2 || parts.length > 3) {
          throw new Error(
            `[AccessNexus] Table "${tableName}": invalid reference "${ref}". Expected "table.column" or "schema.table.column"`
          );
        }

        // Validate referenced table exists (skip external schemas like 'auth')
        const refTable = parts.length === 3 ? parts[1] : parts[0];
        const isExternalSchema = parts.length === 3;
        if (!isExternalSchema && !tableNames.has(refTable)) {
          throw new Error(
            `[AccessNexus] Table "${tableName}": references table "${refTable}" which is not defined in schema`
          );
        }
      }
    }
  }

  return tables;
}

function withSoftDeleteTrigger<T extends { softDelete?: string; triggers?: any[] }>(tableDef: T): T {
  if (!tableDef.softDelete) return tableDef;

  const existingTriggers = tableDef.triggers ?? [];
  const alreadyHasSoftDelete = existingTriggers.some((trigger) => trigger?.kind === 'soft_delete');
  if (alreadyHasSoftDelete) return tableDef;

  return {
    ...tableDef,
    triggers: [
      ...existingTriggers,
      { kind: 'soft_delete', column: tableDef.softDelete },
    ],
  };
}

function assertIdentifier(identifier: string, context: string): void {
  const valid = /^_?[a-z][a-z0-9_]*$/.test(identifier);
  if (!valid) {
    throw new Error(
      `[AccessNexus] Invalid ${context} identifier "${identifier}". Use lowercase snake_case (e.g. "user_profiles").`
    );
  }
}

/** Options accepted by {@link defineConfig} (the `accessnexus.config.ts` file). */
export interface DefineConfigOptions {
  /** Path to schema file (default: './accessnexus.schema.ts') */
  schema?: string;

  /** Path to seed file (default: './accessnexus.seed.ts') */
  seed?: string;

  /** Output directories */
  output?: {
    /** Base output directory (default: './generated') */
    dir?: string;
    /** Migration SQL files (default: '{dir}/migrations') */
    migrations?: string;
    /** RLS policy SQL files (default: '{dir}/policies') */
    policies?: string;
    /** Trigger SQL files (default: '{dir}/triggers') */
    triggers?: string;
    /** RPC SQL files (default: '{dir}/rpcs') */
    rpcs?: string;
    /** Typed SDK files (default: '{dir}/sdk') */
    sdk?: string;
  };

  /** Which adapter to use (default: 'supabase') */
  adapter?: string;

  /** Adapter-specific options */
  adapterOptions?: Record<string, unknown>;

  /** Naming conventions */
  naming?: {
    /** Prefix for generated policy names (default: 'accessnexus') */
    policyPrefix?: string;
  };

  /** Generation mode */
  generate?: {
    /** Generate only SQL, skip SDK */
    sqlOnly?: boolean;
    /** Generate only SDK, skip SQL */
    sdkOnly?: boolean;
  };

  /**
   * Named deploy targets for `push` / `seed --target <name>`, e.g. separate
   * staging and production databases (each with its own `dbUrlEnv`).
   *
   * @example
   * ```ts
   * targets: {
   *   staging: { adapter: 'supabase', adapterOptions: { dbUrlEnv: 'STAGING_DB_URL' } },
   *   prod: { adapter: 'supabase', adapterOptions: { dbUrlEnv: 'PROD_DB_URL' } },
   * }
   * ```
   */
  targets?: Record<string, AccessNexusTarget>;

  /**
   * Several adapters to choose from with `--adapter <name>` (only `'supabase'`
   * exists today). Usually omitted: `adapter` + `adapterOptions` is enough.
   */
  adapters?: Array<string | AccessNexusTarget>;
}

/** A deploy target / adapter entry in {@link DefineConfigOptions}. */
export interface AccessNexusTarget {
  /** Adapter name (only `'supabase'` today). */
  adapter: string;
  /** Adapter options, e.g. `{ dbUrlEnv: 'PROD_DB_URL' }`. */
  adapterOptions?: Record<string, unknown>;
}

/** Resolved config with all defaults applied */
export type ResolvedConfig = Required<Pick<DefineConfigOptions, 'schema' | 'seed' | 'adapter'>> & {
  output: Required<NonNullable<DefineConfigOptions['output']>>;
  adapterOptions?: Record<string, unknown>;
  targets?: Record<string, AccessNexusTarget>;
  adapters?: Array<string | AccessNexusTarget>;
  naming: Required<NonNullable<DefineConfigOptions['naming']>>;
  generate: Required<NonNullable<DefineConfigOptions['generate']>>;
};

/**
 * Define AccessNexus configuration (default export of `accessnexus.config.ts`). Every
 * field is optional; output folders default to `./generated/<category>`.
 * CLI flags (`--schema`, `--output`, `--prefix`...) override these values.
 *
 * Create a `accessnexus.config.ts` file at the project root:
 *
 * @example
 * ```ts
 * // accessnexus.config.ts
 * import { defineConfig } from 'accessnexus';
 *
 * export default defineConfig({
 *   schema: './accessnexus.schema.ts',
 *   output: {
 *     dir: './generated',
 *     migrations: './supabase/migrations',
 *     policies: './supabase/migrations/policies',
 *     triggers: './supabase/migrations/triggers',
 *     rpcs: './supabase/migrations/rpcs',
 *     sdk: './src/lib/accessnexus',
 *   },
 *   naming: {
 *     policyPrefix: 'app',
 *   },
 * });
 * ```
 */
export function defineConfig(options: DefineConfigOptions): ResolvedConfig {
  const dir = options.output?.dir ?? './generated';
  return {
    schema: options.schema ?? './accessnexus.schema.ts',
    seed: options.seed ?? './accessnexus.seed.ts',
    output: {
      dir,
      migrations: options.output?.migrations ?? `${dir}/migrations`,
      policies: options.output?.policies ?? `${dir}/policies`,
      triggers: options.output?.triggers ?? `${dir}/triggers`,
      rpcs: options.output?.rpcs ?? `${dir}/rpcs`,
      sdk: options.output?.sdk ?? `${dir}/sdk`,
    },
    adapter: options.adapter ?? 'supabase',
    adapterOptions: options.adapterOptions,
    naming: {
      policyPrefix: options.naming?.policyPrefix ?? 'accessnexus',
    },
    generate: {
      sqlOnly: options.generate?.sqlOnly ?? false,
      sdkOnly: options.generate?.sdkOnly ?? false,
    },
    ...(options.targets ? { targets: options.targets } : {}),
    ...(options.adapters ? { adapters: options.adapters } : {}),
  };
}
