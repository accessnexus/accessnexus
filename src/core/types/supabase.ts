// ============================================
// AccessNexus - Supabase Database Type Helpers
// Enables type-safe schema from database.types.ts
// ============================================

import type { TablePolicies } from './policy.js';
import type { IndexDef } from './schema.js';
import type { TableTriggers } from './triggers.js';

// ---- Generic Supabase structures ----

/** Matches a single table in Supabase's generated types */
export interface GenericTable {
  Row: Record<string, unknown>;
  Insert: Record<string, unknown>;
  Update: Record<string, unknown>;
  Relationships: unknown[];
}

/** Matches a schema (e.g., 'public') in Supabase's generated types */
export interface GenericSchema {
  Tables: Record<string, GenericTable>;
  Views: Record<string, unknown>;
  Functions: Record<string, unknown>;
  Enums: Record<string, unknown>;
  CompositeTypes: Record<string, unknown>;
}

/**
 * Constraint type that matches any Supabase-generated Database type.
 *
 * The Supabase CLI generates types like:
 * ```ts
 * export type Database = {
 *   public: {
 *     Tables: { profiles: { Row: {...}, Insert: {...}, ... }, ... }
 *     Views: { ... }
 *     ...
 *   }
 * }
 * ```
 */
export type SupabaseDatabase = {
  public: GenericSchema;
  [schema: string]: GenericSchema;
};

// ---- Type extraction helpers ----

/** Extract the public schema from a Database type */
export type PublicSchema<DB extends SupabaseDatabase> = DB['public'];

/** Extract the Tables map from a Database type */
export type TablesOf<DB extends SupabaseDatabase> = PublicSchema<DB>['Tables'];

/** Extract table names from a Database type */
export type TableNamesOf<DB extends SupabaseDatabase> = keyof TablesOf<DB> & string;

/** Extract the Row type for a specific table */
export type RowOf<
  DB extends SupabaseDatabase,
  T extends TableNamesOf<DB>,
> = TablesOf<DB>[T] extends { Row: infer R extends Record<string, unknown> } ? R : never;

/** Extract the Insert type for a specific table */
export type InsertOf<
  DB extends SupabaseDatabase,
  T extends TableNamesOf<DB>,
> = TablesOf<DB>[T] extends { Insert: infer I extends Record<string, unknown> } ? I : never;

/** Extract the Update type for a specific table */
export type UpdateOf<
  DB extends SupabaseDatabase,
  T extends TableNamesOf<DB>,
> = TablesOf<DB>[T] extends { Update: infer U extends Record<string, unknown> } ? U : never;

/** Extract the Functions map from a Database type */
export type FunctionsOf<DB extends SupabaseDatabase> = PublicSchema<DB>['Functions'];

/** Extract function names from a Database type */
export type FunctionNamesOf<DB extends SupabaseDatabase> = keyof FunctionsOf<DB> & string;

// ---- Schema input types ----

/**
 * Table configuration when using Supabase Database types.
 * No `columns` needed — they come from the Database type.
 * Column names in `primaryKey`, `references`, and `softDelete` are
 * type-checked against the table's Row type.
 */
export interface SupabaseTableDef<TRow extends Record<string, unknown> = Record<string, unknown>> {
  /** Primary key column name (autocompleted from Database type) */
  primaryKey?: keyof TRow & string;

  /** Foreign key references: column -> 'table.column' */
  references?: Partial<Record<keyof TRow & string, string>>;

  /** Access control policies */
  policies?: TablePolicies;

  /** Database triggers */
  triggers?: TableTriggers;

  /** Enable RLS (default: true if policies are defined) */
  enableRLS?: boolean;

  /** Table-level indexes */
  indexes?: IndexDef[];

  /** Soft delete column (autocompleted from Database type) */
  softDelete?: keyof TRow & string;
}

/**
 * Schema input when using Supabase Database types.
 * Table names are autocompleted from the Database type.
 * Only list the tables you want to configure (all are optional).
 *
 * @example
 * ```ts
 * import type { Database } from './database.types';
 *
 * defineSchema<Database>({
 *   profiles: {
 *     policies: {
 *       select: policy.isAuthenticated(),
 *       insert: policy.isOwner('id'),
 *     },
 *   },
 * });
 * ```
 */
export type SupabaseSchemaInput<DB extends SupabaseDatabase> = {
  [K in TableNamesOf<DB>]?: SupabaseTableDef<RowOf<DB, K>>;
};
