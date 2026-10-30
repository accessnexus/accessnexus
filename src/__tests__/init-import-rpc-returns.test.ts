// `init --db-url` import of functions returning TABLE(...) / SETOF, and of
// functions rpc() cannot fully express (they keep their real args).
import { describe, expect, it } from 'vitest';
import { generateSchemaFromIntrospection, mapReturnType } from '../cli/init/schema-gen.js';
import type { IntrospectedFunction } from '../cli/init/introspect-db.js';
import { SupabaseAdapter } from '../adapters/supabase/adapter.js';
import { checkSchema } from '../cli/schema-check.js';
import { defineSchema, policy, rpc, table } from '../index.js';

const fn = (name: string, extra: Partial<IntrospectedFunction>): IntrospectedFunction => ({
  name, args: '', returns: 'integer', language: 'sql', security: 'invoker', volatility: 'stable',
  config: { search_path: 'pg_catalog, public' }, body: 'SELECT 1', ...extra,
});

const out = generateSchemaFromIntrospection({
  policyPrefix: 'accessnexus',
  tables: [{ name: 'bookings', columns: [{ table_name: 'bookings', column_name: 'id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO', column_default: null, ordinal_position: 1, formatted_type: 'uuid', identity: '', generated: false } as any], primaryKey: 'id', foreignKeys: [], uniqueColumns: [], policies: [] }],
  functions: [
    fn('get_client_bookings', {
      args: 'p_client_id uuid',
      returns: 'TABLE(booking_id uuid, date_time timestamp with time zone, services json, has_review boolean, total numeric)',
      security: 'definer',
    }),
    fn('bookings_of', { args: 'p_client_id uuid', returns: 'SETOF bookings' }),
    fn('qualified_setof', { returns: 'SETOF public.bookings' }),
    fn('ids', { returns: 'SETOF uuid' }),
    fn('rec', { args: 'p_id uuid, p_limit integer DEFAULT 10', returns: 'record' }),
    fn('composite_arg', { args: 'p_row bookings', returns: 'integer' }),
    fn('no_args_record', { returns: 'record' }),
  ],
});

describe('mapReturnType', () => {
  it('maps scalars, void, TABLE and SETOF', () => {
    expect(mapReturnType('void')).toBe(`'void'`);
    expect(mapReturnType('timestamp with time zone')).toBe(`'timestamptz'`);
    expect(mapReturnType('TABLE(a integer, "b" text[])')).toBe(`{ table: { a: 'int', b: 'text[]' } }`);
    expect(mapReturnType('SETOF t', new Set(['t']))).toBe(`{ setof: 't' }`);
    expect(mapReturnType('SETOF other')).toBeNull();
    expect(mapReturnType('record')).toBeNull();
    expect(mapReturnType('TABLE(a my_composite)')).toBeNull();
  });
});

describe('init import of TABLE / SETOF / non-representable functions', () => {
  it('imports TABLE(...) and SETOF returns with their args and body', () => {
    expect(out).toContain("args: { p_client_id: 'uuid' },\n      returns: { table: { booking_id: 'uuid', date_time: 'timestamptz', services: 'json', has_review: 'boolean', total: 'numeric' } },");
    expect(out).toContain("returns: { setof: 'bookings' },");
    expect(out).toMatch(/qualified_setof: rpc\(\{\n {6}returns: \{ setof: 'bookings' \},/);
    expect(out).toContain("returns: { setof: 'uuid' },");
    expect(out).toMatch(/get_client_bookings: rpc\(\{[\s\S]*?security: 'definer',[\s\S]*?body: `SELECT 1`/);
  });

  it('keeps the real args on signature-only functions (never an empty rpc() when args exist)', () => {
    expect(out).toMatch(/rec: rpc\(\{\n {6}args: \{ p_id: 'uuid', p_limit: \{ type: 'int', default: '10' \} \},\n {4}\}\),/);
    expect(out).toMatch(/composite_arg: rpc\(\{\n {6}args: \{ p_row: 'json' \},\n {6}returns: 'int',\n {4}\}\),/);
    expect(out).toContain('argument p_row is bookings, typed as json');
    expect(out).toContain('no_args_record: rpc(),');
  });

  it('round-trips into SQL and SDK types that validate', () => {
    const body = out.replace(/^import .*$/m, '').replace('export default ', 'return ');
    const schema = new Function('defineSchema', 'table', 'policy', 'rpc', body)(defineSchema, table, policy, rpc);
    expect(checkSchema(schema).filter((i) => i.severity === 'error')).toEqual([]);
    const adapter = new SupabaseAdapter({ deterministic: true });
    const sql = adapter.generateRpcs(schema)[0].content;
    expect(sql).toContain('RETURNS TABLE(booking_id UUID, date_time TIMESTAMPTZ, services JSON, has_review BOOLEAN, total NUMERIC)');
    expect(sql).toContain('RETURNS SETOF bookings');
    expect(sql).not.toContain('FUNCTION rec(');
    expect(sql).not.toContain('FUNCTION composite_arg(');
    const types = adapter.generateClient(schema).find((f) => f.path === 'types.ts')!.content;
    expect(types).toContain('Args: { p_client_id: string };\n        Returns: { booking_id: string; date_time: string; services: Json; has_review: boolean; total: number }[];');
    expect(types).toMatch(/rec: \{\n\s+Args: \{ p_id: string; p_limit\?: number \};\n\s+Returns: unknown;/);
    expect(types).not.toMatch(/rec: \{\n\s+Args: Record<string, never>/);
  });
});
