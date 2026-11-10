// ============================================
// AccessNexus - defineEnum
// ============================================

import type { EnumDef } from '../types/enum.js';

/**
 * A named Postgres enum shared by columns and RPCs (one `CREATE TYPE`, no casts
 * between per-column enums). Register it with `defineSchema(tables, { enums: [role] })`
 * and use `role.type` / `role.nullable` as the column type.
 *
 * @example
 * ```ts
 * const memberRole = defineEnum('member_role', ['owner', 'admin', 'member', 'viewer']);
 * // columns: { role: { type: memberRole.type, default: "'member'" } }
 * // rpc args / returns.table: { role: memberRole.type }
 * ```
 */
export function defineEnum<const TValues extends readonly string[]>(name: string, values: TValues): EnumDef<TValues> {
  return { name, values, type: `enum:${name}`, nullable: `enum:${name}?` };
}
