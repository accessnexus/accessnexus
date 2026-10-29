// ============================================
// AccessNexus - PostgreSQL Type Mapping
// Maps PG udt_name to AccessNexus ColumnType
// ============================================

import type { ColumnType, ScalarType } from '../../core/types/columns.js';

const PG_TYPE_MAP: Record<string, ScalarType> = {
  // UUIDs
  uuid: 'uuid',

  // Text types
  text: 'text',
  varchar: 'text',
  char: 'text',
  bpchar: 'text',
  name: 'text',
  citext: 'text',

  // Integer types
  int2: 'int',
  int4: 'int',
  smallint: 'int',
  integer: 'int',
  serial: 'int',

  // Bigint types
  int8: 'bigint',
  bigserial: 'bigint',

  // Float types
  float4: 'float',
  float8: 'float',
  numeric: 'numeric',
  decimal: 'numeric',
  real: 'float',
  'double precision': 'float',

  // Boolean
  bool: 'boolean',
  boolean: 'boolean',

  // JSON
  json: 'json',
  jsonb: 'jsonb',

  // Date/time
  date: 'date',
  timestamp: 'timestamp',
  timestamptz: 'timestamptz',
  time: 'time',
  timetz: 'time',
};

/**
 * Map a PostgreSQL data type (from information_schema.columns.udt_name)
 * to a AccessNexus ColumnType.
 */
export function pgTypeToAccessNexus(udtName: string, isNullable: boolean): ColumnType {
  const base: ScalarType = PG_TYPE_MAP[udtName] ?? 'text';
  return (isNullable ? `${base}?` : base) as ColumnType;
}

/** Array element udt names (`_text`) that map to an AccessNexus array type. */
const PG_ARRAY_MAP: Record<string, ScalarType> = {
  _text: 'text[]',
  _varchar: 'text[]',
  _int4: 'int[]',
  _uuid: 'uuid[]',
};

/** Exact (direct DB) types that map 1:1, by udt name. */
const PG_EXACT_MAP: Record<string, ScalarType> = {
  ...PG_TYPE_MAP,
  int2: 'smallint',
  varchar: 'varchar',
};

/**
 * The AccessNexus type of a column read through a direct DB connection, plus
 * notes for anything that does not round-trip exactly (emitted as comments).
 * Unlike {@link pgTypeToAccessNexus} it keeps numeric precision, enum labels
 * and array element types.
 */
export function introspectedColumnType(col: {
  udt_name: string;
  is_nullable: 'YES' | 'NO';
  formatted_type?: string;
  enum_values?: string[];
}): { type: string; notes: string[] } {
  const notes: string[] = [];
  const nullable = col.is_nullable === 'YES' ? '?' : '';
  const formatted = (col.formatted_type ?? col.udt_name).toLowerCase();

  if (col.enum_values && col.enum_values.length > 0) {
    if (col.enum_values.some((v) => v.includes("'") || v.includes(','))) {
      notes.push(`enum type ${col.udt_name} has labels with quotes/commas; imported as text`);
      return { type: `text${nullable}`, notes };
    }
    notes.push(`enum type ${col.udt_name}: AccessNexus recreates it as its own enum type on push`);
    return { type: `enum(${col.enum_values.map((v) => `'${v}'`).join(',')})${nullable}`, notes };
  }

  const numeric = /^numeric(?:\((\d+)(?:,(\d+))?\))?$/.exec(formatted);
  if (numeric) {
    const type = numeric[1] === undefined ? 'numeric' : numeric[2] === undefined ? `numeric(${numeric[1]})` : `numeric(${numeric[1]},${numeric[2]})`;
    return { type: type + nullable, notes };
  }

  if (col.udt_name.startsWith('_')) {
    const mapped = PG_ARRAY_MAP[col.udt_name];
    if (mapped) {
      if (col.udt_name === '_varchar') notes.push(`was ${formatted}; imported as text[]`);
      return { type: mapped + nullable, notes };
    }
    notes.push(`WARNING: array type ${formatted} has no AccessNexus equivalent; imported as text — fix the type before pushing`);
    return { type: `text${nullable}`, notes };
  }

  const mapped = PG_EXACT_MAP[col.udt_name];
  if (!mapped) {
    notes.push(`WARNING: type ${formatted} has no AccessNexus equivalent; imported as text — fix the type before pushing`);
    return { type: `text${nullable}`, notes };
  }
  if (/^(character varying|character|bit|time|timestamp)\(/.test(formatted) || ['float4', 'real', 'timetz', 'char', 'bpchar', 'citext', 'name'].includes(col.udt_name)) {
    notes.push(`was ${formatted}; imported as ${mapped}`);
  }
  return { type: mapped + nullable, notes };
}
