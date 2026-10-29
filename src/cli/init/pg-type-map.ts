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
  numeric: 'float',
  decimal: 'float',
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
