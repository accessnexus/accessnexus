// ============================================
// AccessNexus - Seed Builders
// ============================================

import type { SchemaDef } from '../types/schema.js';
import type { SupabaseDatabase } from '../types/supabase.js';
import type { SeedDataFromDatabase, SeedDataFromSchema, SeedDef } from '../types/seed.js';

/**
 * Define seed data (manual mode): rows per table, type-checked against the
 * schema's table names. Default-export it from `accessnexus.seed.ts`; `accessnexus seed`
 * (and `push`, afterwards) inserts it.
 *
 * @example
 * ```ts
 * import { defineSeed } from 'accessnexus';
 * import schema from './accessnexus.schema';
 *
 * export default defineSeed(schema, {
 *   profiles: [{ id: '00000000-0000-0000-0000-000000000001', name: 'Admin' }],
 * });
 * ```
 */
export function defineSeed<T extends SchemaDef>(
  schema: T,
  data: SeedDataFromSchema<T>
): SeedDef;

/**
 * Define seed data (Database mode): rows typed by your Supabase `Database` type.
 *
 * @example
 * ```ts
 * import { defineSeed } from 'accessnexus';
 * import type { Database } from './database.types';
 *
 * export default defineSeed<Database>({
 *   profiles: [{ id: '00000000-0000-0000-0000-000000000001', name: 'Admin' }],
 * });
 * ```
 */
export function defineSeed<DB extends SupabaseDatabase>(
  data: SeedDataFromDatabase<DB>
): SeedDef;

// Implementation
export function defineSeed(arg1: any, arg2?: any): SeedDef {
  if (arg2) {
    // Manual mode: arg1 is schema, arg2 is data
    return arg2 as SeedDef;
  }
  // Database mode: arg1 is data
  return arg1 as SeedDef;
}
