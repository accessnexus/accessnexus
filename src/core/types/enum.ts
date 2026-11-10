// ============================================
// AccessNexus - Shared enum types
// ============================================

/**
 * A Postgres enum type shared by several columns and RPCs, from `defineEnum()`.
 * Use `type` (or `nullable`) as the column type string.
 */
export interface EnumDef<TValues extends readonly string[] = readonly string[]> {
  readonly name: string;
  readonly values: TValues;
  /** Column / RPC type string: `'enum:<name>'`. */
  readonly type: `enum:${string}`;
  /** Nullable column type string: `'enum:<name>?'`. */
  readonly nullable: `enum:${string}?`;
}
