// `init --db-url` import: exact column types and defaults, keys, triggers and
// RPC parameter defaults, and the SQL AccessNexus generates for them.
import { describe, expect, it, vi } from 'vitest';
import type { IntrospectedColumn, IntrospectedTable, IntrospectedTrigger } from '../cli/init/introspect.js';
import { generateSchemaFromIntrospection, parseFunctionArgs, renderTriggers } from '../cli/init/schema-gen.js';
import { SupabaseAdapter } from '../adapters/supabase/adapter.js';
import { checkSchema } from '../cli/schema-check.js';
import { defineSchema, rpc, table, trigger } from '../index.js';

// A fake pg driver that fails if a second query starts before the first ends.
let inFlight = 0;
let overlapped = false;
vi.mock('pg', () => {
  class Client {
    async connect() {}
    async end() {}
    async query() {
      inFlight++;
      if (inFlight > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return { rows: [] };
    }
  }
  return { default: { Client }, Client };
});

const col = (name: string, udt: string, extra: Partial<IntrospectedColumn> = {}): IntrospectedColumn => ({
  table_name: 't',
  column_name: name,
  data_type: udt,
  udt_name: udt,
  is_nullable: 'NO',
  column_default: null,
  ordinal_position: 1,
  formatted_type: udt,
  identity: '',
  generated: false,
  ...extra,
});

const tbl = (t: Partial<IntrospectedTable> & Pick<IntrospectedTable, 'name' | 'columns'>): IntrospectedTable => ({
  foreignKeys: [],
  uniqueColumns: [],
  policies: [],
  rlsEnabled: true,
  ...t,
});

const trg = (t: Partial<IntrospectedTrigger> & Pick<IntrospectedTrigger, 'name' | 'tgtype'>): IntrospectedTrigger => ({
  definition: `CREATE TRIGGER ${t.name} ...`,
  nargs: 0,
  updateColumns: [],
  isConstraint: false,
  enabled: 'O',
  functionName: 'fn',
  functionSchema: 'public',
  language: 'plpgsql',
  security: 'invoker',
  body: '\nBEGIN\n  RETURN NEW;\nEND;\n',
  ...t,
});

describe('introspectViaDb', () => {
  it('runs its catalog queries one at a time on the single pg client', async () => {
    const { introspectViaDb } = await import('../cli/init/introspect-db.js');
    await introspectViaDb('postgres://u:p@127.0.0.1:1/db');
    expect(overlapped).toBe(false);
  });
});

describe('column import', () => {
  const src = generateSchemaFromIntrospection({
    policyPrefix: 'accessnexus',
    tables: [tbl({
      name: 'orders',
      columns: [
        col('id', 'int4', { column_default: "nextval('orders_id_seq'::regclass)" }),
        col('total', 'numeric', { formatted_type: 'numeric(10,2)', column_default: '0' }),
        col('ratio', 'numeric', { is_nullable: 'YES' }),
        col('status', 'order_status', { enum_values: ['new', 'paid'], column_default: "'new'::order_status" }),
        col('tags', '_text', { formatted_type: 'text[]', column_default: "'{}'::text[]" }),
        col('ids', '_int8', { formatted_type: 'bigint[]' }),
        col('code', 'varchar', { formatted_type: 'character varying(20)' }),
        col('created_at', 'timestamptz', { formatted_type: 'timestamp with time zone', column_default: 'now()' }),
        col('total_x2', 'numeric', { generated: true, column_default: '(total * 2)' }),
        col('owner_id', 'uuid'),
        col('shop_id', 'uuid'),
        col('a', 'text'),
        col('b', 'text'),
      ],
      primaryKey: 'id',
      foreignKeys: [
        { column: 'owner_id', referencedTable: 'users', referencedColumn: 'id', referencedSchema: 'auth', onDelete: 'cascade' },
        { column: 'shop_id', referencedTable: 'shops', referencedColumn: 'id' },
      ],
      compositeForeignKeys: ['orders_ab_fkey: FOREIGN KEY (a, b) REFERENCES other(a, b)'],
      uniqueGroups: [['a', 'b']],
    }), tbl({
      name: 'members',
      columns: [col('org_id', 'uuid'), col('user_id', 'uuid')],
      compositePrimaryKey: ['org_id', 'user_id'],
    })],
  });

  it('keeps numeric precision, enums, arrays and defaults', () => {
    expect(src).toContain("id: 'serial',");
    expect(src).toContain("total: { type: 'numeric(10,2)', default: '0' },");
    expect(src).toContain("ratio: 'numeric?',");
    expect(src).toContain(`status: { type: "enum('new','paid')", default: "'new'" },`);
    expect(src).toContain(`tags: { type: 'text[]', default: "'{}'::text[]" },`);
    expect(src).toContain("created_at: { type: 'timestamptz', default: 'now()' },");
    expect(src).toContain("code: 'varchar',");
  });

  it('flags what it cannot represent instead of dropping it silently', () => {
    expect(src).toContain('// ids: WARNING: array type bigint[] has no AccessNexus equivalent');
    expect(src).toContain('// total_x2: WARNING: generated column');
    expect(src).toContain("total_x2: 'numeric',");
    expect(src).toContain('// code: was character varying(20); imported as varchar');
    expect(src).toContain('// WARNING: multi-column foreign key not imported');
  });

  it('keeps FKs to other schemas, ON DELETE, composite keys and composite UNIQUE', () => {
    expect(src).toContain("owner_id: 'auth.users.id',");
    expect(src).toContain("shop_id: 'shops.id',");
    expect(src).toContain("onDelete: { owner_id: 'cascade' },");
    expect(src).toContain("{ columns: ['a', 'b'], unique: true },");
    expect(src).toContain("compositePrimaryKey: ['org_id', 'user_id'],");
    expect(src).not.toContain("a: { type: 'text', unique: true }");
  });
});

describe('trigger import', () => {
  const ROW = 1, BEFORE = 2, INSERT = 4, DELETE = 8, UPDATE = 16, TRUNCATE = 32;

  it('emits trigger.custom with events, timing, WHEN, FOR EACH and security', () => {
    const { lines, usesBuilder } = renderTriggers({
      name: 'orders',
      triggers: [
        trg({
          name: 'note', tgtype: ROW | BEFORE | INSERT | UPDATE, security: 'definer',
          definition: 'CREATE TRIGGER note BEFORE INSERT OR UPDATE ON public.orders FOR EACH ROW WHEN ((new.note IS NULL)) EXECUTE FUNCTION order_note()',
        }),
        trg({ name: 'stmt', tgtype: DELETE }),
      ],
    }, 'accessnexus');
    const out = lines.join('\n');
    expect(usesBuilder).toBe(true);
    expect(out).toContain("name: 'note',");
    expect(out).toContain("events: ['before_insert', 'before_update'],");
    expect(out).toContain("when: '(new.note IS NULL)',");
    expect(out).toContain("security: 'definer',");
    expect(out).toContain("events: ['after_delete'],");
    expect(out).toContain("forEach: 'statement',");
    expect(out).toContain('--replace-foreign-triggers');
  });

  it('skips its own triggers and warns about what trigger.custom cannot express', () => {
    const { lines } = renderTriggers({
      name: 'orders',
      triggers: [
        trg({ name: 'accessnexus_orders_updated_at', tgtype: ROW | BEFORE | UPDATE }),
        trg({ name: 'with_args', tgtype: ROW | BEFORE | INSERT, nargs: 1 }),
        trg({ name: 'off', tgtype: ROW | BEFORE | INSERT, enabled: 'D' }),
        trg({ name: 'js', tgtype: ROW | BEFORE | INSERT, language: 'plv8' }),
        trg({ name: 'trunc', tgtype: TRUNCATE }),
        trg({ name: 'cols', tgtype: ROW | BEFORE | UPDATE, updateColumns: ['status'] }),
        trg({ name: 'Mixed-Case', tgtype: ROW | INSERT | UPDATE, updateColumns: ['status'] }),
      ],
    }, 'accessnexus');
    const out = lines.join('\n');
    expect(out).not.toContain('accessnexus_orders_updated_at');
    expect(out).toContain('trigger with_args not imported');
    expect(out).toContain('trigger off not imported');
    expect(out).toContain('trigger js not imported');
    expect(out).toContain('trigger trunc not imported');
    expect(out).toContain("when: 'OLD.status IS DISTINCT FROM NEW.status',");
    expect(out).toContain('WARNING: was UPDATE OF status; now fires on every UPDATE');
    expect(out).toContain("name: 'mixed_case',");
  });
});

describe('RPC parameter defaults', () => {
  it('parses DEFAULT expressions, including quoted commas', () => {
    expect(parseFunctionArgs("payload text, seed integer DEFAULT 65535, label text DEFAULT 'a,b'::text, OUT r int")).toEqual({
      payload: { type: 'text' },
      seed: { type: 'integer', default: '65535' },
      label: { type: 'text', default: "'a,b'::text" },
    });
  });

  it('emits them in CREATE FUNCTION and makes them optional in the client types', () => {
    const schema = defineSchema({
      t: table({ columns: { id: 'uuid' }, primaryKey: 'id' }),
    }, {
      rpcs: {
        _pix_crc16: rpc({
          args: { payload: 'text', seed: { type: 'int', default: '65535' } },
          returns: 'int',
          security: 'definer',
          body: 'RETURN length(payload) + seed;',
        }),
      },
    });
    const adapter = new SupabaseAdapter({ deterministic: true });
    const sql = adapter.generateRpcs(schema)[0].content;
    expect(sql).toContain('CREATE OR REPLACE FUNCTION _pix_crc16(payload TEXT, seed INTEGER DEFAULT 65535)');
    expect(sql).toContain('REVOKE EXECUTE ON FUNCTION _pix_crc16(TEXT, INTEGER) FROM PUBLIC, anon;');
    const client = adapter.generateClient(schema).map((f) => f.content).join('\n');
    expect(client).toContain('Args: { payload: string; seed?: number };');
    expect(checkSchema(schema).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('validate rejects a parameter without default after one with a default', () => {
    const issues = checkSchema(defineSchema({ t: table({ columns: { id: 'uuid' }, primaryKey: 'id' }) }, {
      rpcs: { f: rpc({ args: { a: { type: 'int', default: '1' }, b: 'int' }, returns: 'int', body: 'RETURN a + b;' }) },
    }));
    expect(issues.map((i) => `${i.code}:${i.path}`)).toContain('INVALID_DEFAULT:rpcs.f.args.b');
  });
});

describe('generated SQL for imported shapes', () => {
  const schema = defineSchema({
    members: table({
      columns: { org_id: 'uuid', user_id: 'uuid', _note: 'text?' },
      compositePrimaryKey: ['org_id', 'user_id'],
      references: { user_id: 'auth.users.id' },
    }),
    prices: table({
      columns: { id: 'uuid', amount: 'numeric(10,2)', ratio: 'numeric?' },
      primaryKey: 'id',
      triggers: [
        trigger.custom({
          name: 'own_block',
          events: ['before_insert'],
          functionBody: 'DECLARE x int := 1;\nBEGIN\n  RETURN NEW;\nEND;',
        }),
      ],
    }),
  });
  const adapter = new SupabaseAdapter({ deterministic: true });
  const migration = adapter.generateMigrations(schema).map((f) => f.content).join('\n');

  it('emits a table-level composite PRIMARY KEY and exact numeric types', () => {
    expect(migration).toContain('  PRIMARY KEY (org_id, user_id)');
    expect(migration).toContain('user_id UUID NOT NULL REFERENCES auth.users(id)');
    expect(migration).toContain('amount NUMERIC(10,2) NOT NULL');
    expect(migration).toContain('ratio NUMERIC');
  });

  it('does not wrap a trigger body that has its own DECLARE/BEGIN block', () => {
    const sql = adapter.generateTriggers(schema).map((f) => f.content).join('\n');
    expect(sql).toContain('RETURNS TRIGGER AS $$\nDECLARE x int := 1;\nBEGIN');
    expect(sql).not.toContain('BEGIN\n  DECLARE');
  });

  it('validate accepts _-prefixed names, numeric(p,s) and composite keys', () => {
    expect(checkSchema(schema).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('validate rejects softDelete on a composite key and both key kinds at once', () => {
    const issues = checkSchema({
      a: { columns: { x: 'uuid', y: 'uuid', deleted_at: 'timestamptz?' }, compositePrimaryKey: ['x', 'y'], softDelete: 'deleted_at' },
      b: { columns: { x: 'uuid', y: 'uuid' }, primaryKey: 'x', compositePrimaryKey: ['x', 'y'] },
    } as any).map((i) => `${i.code}:${i.path}`);
    expect(issues).toContain('INVALID_PRIMARY_KEY:a.softDelete');
    expect(issues).toContain('INVALID_PRIMARY_KEY:b.compositePrimaryKey');
  });
});
