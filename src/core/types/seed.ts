// ============================================
// AccessNexus - Seed Data Types
// ============================================

import type { SchemaDef } from './schema.js';
import type { SupabaseDatabase, InsertOf, TableNamesOf } from './supabase.js';

/**
 * Seed data inferred from a generic Schema definition.
 * Used in Manual Mode.
 */
export type SeedDataFromSchema<T extends SchemaDef> = {
  [K in keyof T]?: Array<Record<string, unknown>>;
};

/**
 * Seed data inferred from Supabase Database types.
 * Used in Database Mode.
 */
export type SeedDataFromDatabase<DB extends SupabaseDatabase> = {
  [K in TableNamesOf<DB>]?: Array<InsertOf<DB, K>>;
};

/**
 * Runtime definition of seed data.
 * A map of table names to arrays of record objects.
 */
export type SeedDef = Record<string, Array<Record<string, unknown>>>;
