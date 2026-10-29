// ============================================
// AccessNexus - Core Column Types
// Adapter-agnostic type definitions
// ============================================

/**
 * Scalar column types supported across all adapters.
 * Each adapter maps these to its native types.
 * 
 * Append '?' to make nullable: 'text?' = nullable text
 */
export type ScalarType =
  | 'uuid'
  | 'text'
  | 'varchar'
  | 'int'
  | 'smallint'
  | 'bigint'
  | 'serial'
  | 'float'
  | 'decimal'
  | 'boolean'
  | 'json'
  | 'jsonb'
  | 'date'
  | 'timestamp'
  | 'timestamptz'
  | 'time'
  | 'text[]'
  | 'int[]'
  | 'uuid[]'
  | `enum(${string})`;

/** Nullable version of any scalar type */
export type NullableType = `${ScalarType}?`;

/** All possible column type strings */
export type ColumnType = ScalarType | NullableType;

/** Extract whether a column type is nullable */
export type IsNullable<T extends ColumnType> = T extends `${string}?` ? true : false;

/** Map column type strings to TypeScript types */
export type ColumnTSType<T extends ColumnType> =
  T extends 'uuid' | 'text' | 'varchar' | 'date' | 'timestamp' | 'timestamptz' | 'time' ? string :
  T extends 'uuid?' | 'text?' | 'varchar?' | 'date?' | 'timestamp?' | 'timestamptz?' | 'time?' ? string | null :
  T extends 'int' | 'smallint' | 'bigint' | 'serial' | 'float' | 'decimal' ? number :
  T extends 'int?' | 'smallint?' | 'bigint?' | 'serial?' | 'float?' | 'decimal?' ? number | null :
  T extends 'boolean' ? boolean :
  T extends 'boolean?' ? boolean | null :
  T extends 'json' | 'jsonb' ? Record<string, unknown> :
  T extends 'json?' | 'jsonb?' ? Record<string, unknown> | null :
  T extends 'text[]' ? string[] :
  T extends 'text[]?' ? string[] | null :
  T extends 'int[]' ? number[] :
  T extends 'int[]?' ? number[] | null :
  T extends 'uuid[]' ? string[] :
  T extends 'uuid[]?' ? string[] | null :
  T extends `enum(${string})` ? string :
  T extends `enum(${string})?` ? string | null :
  never;

/**
 * What happens to rows referencing a deleted row (`ON DELETE ...`).
 * Without it a foreign key is `NO ACTION`: deleting a parent that still has
 * children fails with a foreign key violation.
 */
export type ForeignKeyAction = 'cascade' | 'set null' | 'restrict' | 'no action';

/** Column definition with optional default and constraints */
export interface ColumnDef {
  type: ColumnType;
  /**
   * Raw SQL default expression, emitted verbatim after `DEFAULT`.
   * Functions: `'now()'`, `'gen_random_uuid()'`; numbers/booleans: `'0'`, `'false'`.
   * String and enum literals need their own single quotes: `"'todo'"` (not `'todo'`,
   * which Postgres would read as a column name). `validate` reports `INVALID_DEFAULT`.
   */
  default?: string;
  unique?: boolean;
  /** Raw SQL CHECK constraint expression, e.g. `'amount >= 0'`. */
  check?: string;
  /** Foreign key target: `'table.column'` or `'schema.table.column'` (e.g. `'auth.users.id'`). */
  references?: string;
  /**
   * `ON DELETE` action for `references` (default: no action — deleting a parent
   * with children fails). `'cascade'` deletes the children, `'set null'` clears
   * this column (it must be nullable).
   */
  onDelete?: ForeignKeyAction;
}

/** Columns can be defined as shorthand string or full object */
export type ColumnInput = ColumnType | ColumnDef;

/** Normalize column input to always be a ColumnDef */
export function normalizeColumn(input: ColumnInput): ColumnDef {
  if (typeof input === 'string') {
    return { type: input };
  }
  return input;
}

/** Check if a column type is nullable */
export function isNullable(type: ColumnType): boolean {
  return type.endsWith('?');
}

/** Get the base type without nullable marker */
export function baseType(type: ColumnType): ScalarType {
  return (type.endsWith('?') ? type.slice(0, -1) : type) as ScalarType;
}
