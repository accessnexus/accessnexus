// ============================================
// AccessNexus - Schema Types
// Adapter-agnostic schema definitions
// ============================================

import type { ColumnInput, ForeignKeyAction } from './columns.js';
import type { TablePolicies } from './policy.js';
import type { SeedDef } from './seed.js';
import type { TableTriggers } from './triggers.js';

/**
 * Table definition — the core building block of a AccessNexus schema.
 */
export interface TableDef<
  TColumns extends Record<string, ColumnInput> = Record<string, ColumnInput>
> {
  /** Column definitions */
  columns: TColumns;

  /** Primary key column name */
  primaryKey?: keyof TColumns & string;

  /** Foreign key references: column -> 'table.column' */
  references?: Partial<Record<keyof TColumns & string, string>>;

  /**
   * `ON DELETE` action per referencing column (default: no action — deleting a
   * parent that still has children fails). Example: `{ project_id: 'cascade' }`.
   */
  onDelete?: Partial<Record<keyof TColumns & string, ForeignKeyAction>>;

  /** Access control policies */
  policies?: TablePolicies;

  /** Database triggers */
  triggers?: TableTriggers;

  /** Enable RLS (default: true if policies are defined) */
  enableRLS?: boolean;

  /** Table-level indexes */
  indexes?: IndexDef[];

  /** Soft delete column (if present, delete becomes update) */
  softDelete?: keyof TColumns & string;
}

/** Index definition */
export interface IndexDef {
  columns: string[];
  unique?: boolean;
  name?: string;
}

/**
 * A schema is a record of table names to table definitions.
 */
export type SchemaDef = Record<string, TableDef>;

/**
 * Adapter interface — every adapter must implement this.
 * This is what makes AccessNexus extensible to different backends.
 */
export interface Adapter {
  /** Adapter identifier */
  readonly name: string;

  /** Generate access control code (RLS, middleware, etc.) */
  generatePolicies(schema: SchemaDef): GeneratedOutput[];

  /** Generate typed client SDK */
  generateClient(schema: SchemaDef): GeneratedOutput[];

  /** Generate migration/DDL (optional) */
  generateMigrations?(schema: SchemaDef): GeneratedOutput[];

  /** Generate database triggers (optional) */
  generateTriggers?(schema: SchemaDef): GeneratedOutput[];

  /** Generate RPC (PostgreSQL function) SQL (optional) */
  generateRpcs?(schema: SchemaDef): GeneratedOutput[];

  /** Generate seed SQL (optional) */
  generateSeed?(schema: SchemaDef, data: SeedDef, options?: SeedSqlOptions): GeneratedOutput[];
}

/** Output from a generator — a file to be written */
export interface GeneratedOutput {
  /** Relative file path */
  path: string;
  /** File content */
  content: string;
  /** Whether this file should overwrite existing (default: true) */
  overwrite?: boolean;
}

/**
 * AccessNexus configuration
 */
export interface AccessNexusConfig {
  /** Path to schema file */
  schema: string;

  /** Output directories — each category can have its own path */
  output: {
    /** Base output directory (default: './generated') */
    dir?: string;
    /** Where to write migration SQL files (default: '{dir}/migrations') */
    migrations?: string;
    /** Where to write RLS policy SQL files (default: '{dir}/policies') */
    policies?: string;
    /** Where to write trigger SQL files (default: '{dir}/triggers') */
    triggers?: string;
    /** Where to write RPC SQL files (default: '{dir}/rpcs') */
    rpcs?: string;
    /** Where to write typed SDK files (default: '{dir}/sdk') */
    sdk?: string;
  };

  /** Which adapter to use */
  adapter: string;

  /** Adapter-specific options */
  adapterOptions?: Record<string, unknown>;

  /** Naming conventions */
  naming?: {
    /** Prefix for generated policies (default: 'accessnexus') */
    policyPrefix?: string;
  };

  /** Generation mode */
  generate?: {
    /** Generate only SQL, skip SDK (default: false) */
    sqlOnly?: boolean;
    /** Generate only SDK, skip SQL (default: false) */
    sdkOnly?: boolean;
  };
}

/** Options for {@link Adapter.generateSeed}. */
export interface SeedSqlOptions {
  /**
   * Password for the `auth.users` rows the seed provisions (for FK targets in
   * auth.users). Omit it to give each user a random, unknowable password —
   * never use a fixed password on a database reachable from the internet.
   */
  authPassword?: string;
}
