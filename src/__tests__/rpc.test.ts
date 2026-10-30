import { describe, it, expect } from 'vitest';
import { rpc } from '../core/rpc/builders.js';
import { defineSchema, table } from '../core/schema/builders.js';
import { SupabaseAdapter } from '../adapters/supabase/adapter.js';

describe('RPC Builder', () => {
  it('should create a marker-only RPC (Database mode)', () => {
    const r = rpc();
    expect(r._rpc).toBe(true);
    expect(r.args).toBeUndefined();
    expect(r.returns).toBeUndefined();
    expect(r.body).toBeUndefined();
  });

  it('should create a signature-only RPC', () => {
    const r = rpc({ args: { user_id: 'uuid' }, returns: 'jsonb' });
    expect(r._rpc).toBe(true);
    expect(r.args).toEqual({ user_id: 'uuid' });
    expect(r.returns).toBe('jsonb');
    expect(r.body).toBeUndefined();
  });

  it('should create a full RPC with body', () => {
    const r = rpc({
      args: { user_id: 'uuid' },
      returns: 'jsonb',
      body: `RETURN '{}';`,
      language: 'plpgsql',
      security: 'invoker',
      immutable: false,
    });
    expect(r._rpc).toBe(true);
    expect(r.args).toEqual({ user_id: 'uuid' });
    expect(r.returns).toBe('jsonb');
    expect(r.body).toBe(`RETURN '{}';`);
    expect(r.language).toBe('plpgsql');
    expect(r.security).toBe('invoker');
    expect(r.immutable).toBe(false);
  });

  it('should default language/security/immutable to undefined', () => {
    const r = rpc({ args: {}, returns: 'text', body: `RETURN 'hi';` });
    expect(r.language).toBeUndefined();
    expect(r.security).toBeUndefined();
    expect(r.immutable).toBeUndefined();
  });
});

describe('defineSchema with RPCs', () => {
  it('should attach RPCs as non-enumerable __rpcs property', () => {
    const schema = defineSchema({
      users: table({ columns: { id: 'uuid', name: 'text' } }),
    }, {
      rpcs: {
        get_stats: rpc({ args: { user_id: 'uuid' }, returns: 'jsonb' }),
      },
    });

    // Tables still enumerable
    expect(Object.keys(schema)).toEqual(['users']);

    // RPCs attached non-enumerably
    expect((schema as any).__rpcs).toBeDefined();
    expect((schema as any).__rpcs.get_stats._rpc).toBe(true);

    // Not visible in Object.entries
    const entries = Object.entries(schema);
    expect(entries.every(([key]) => key !== '__rpcs')).toBe(true);
  });

  it('should work without RPCs (backward compat)', () => {
    const schema = defineSchema({
      users: table({ columns: { id: 'uuid' } }),
    });
    expect((schema as any).__rpcs).toBeUndefined();
  });

  it('should skip __rpcs when rpcs is empty', () => {
    const schema = defineSchema({
      users: table({ columns: { id: 'uuid' } }),
    }, { rpcs: {} });
    expect((schema as any).__rpcs).toBeUndefined();
  });
});

describe('Supabase Adapter — RPC SQL Generation', () => {
  const adapter = new SupabaseAdapter({ timestamps: false });

  it('should generate SQL for RPCs with body', () => {
    const schema = defineSchema({
      users: table({ columns: { id: 'uuid' } }),
    }, {
      rpcs: {
        get_stats: rpc({
          args: { user_id: 'uuid' },
          returns: 'jsonb',
          body: `RETURN '{}';`,
        }),
      },
    });

    const outputs = adapter.generateRpcs(schema);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].path).toBe('rpcs.sql');

    const sql = outputs[0].content;
    expect(sql).toContain('CREATE OR REPLACE FUNCTION get_stats(user_id UUID)');
    expect(sql).toContain('RETURNS JSONB');
    expect(sql).toContain('LANGUAGE plpgsql');
    expect(sql).toContain('SECURITY INVOKER');
    expect(sql).toContain('VOLATILE');
    expect(sql).toContain('SET search_path = pg_catalog, public');
    expect(sql).toContain('BEGIN');
    expect(sql).toContain(`RETURN '{}';`);
    expect(sql).toContain('END;');
  });

  it('should respect language, security, and immutable options', () => {
    const schema = defineSchema({
      users: table({ columns: { id: 'uuid' } }),
    }, {
      rpcs: {
        hello: rpc({
          args: {},
          returns: 'text',
          body: `SELECT 'Hello!';`,
          language: 'sql',
          security: 'definer',
          immutable: true,
        }),
      },
    });

    const sql = adapter.generateRpcs(schema)[0].content;
    expect(sql).toContain('LANGUAGE sql');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('IMMUTABLE');
    // SQL language: no BEGIN/END wrapper (the DO guard before it is plpgsql)
    expect(sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION'))).not.toContain('BEGIN');
    expect(sql).toContain(`SELECT 'Hello!';`);
  });

  it('should generate SQL with multiple arguments', () => {
    const schema = defineSchema({
      users: table({ columns: { id: 'uuid' } }),
    }, {
      rpcs: {
        search: rpc({
          args: { query: 'text', limit_count: 'int', active: 'boolean' },
          returns: 'jsonb',
          body: `RETURN '[]';`,
        }),
      },
    });

    const sql = adapter.generateRpcs(schema)[0].content;
    expect(sql).toContain('search(query TEXT, limit_count INTEGER, active BOOLEAN)');
  });

  it('should skip RPCs without body (no SQL generated)', () => {
    const schema = defineSchema({
      users: table({ columns: { id: 'uuid' } }),
    }, {
      rpcs: {
        marker_only: rpc(),
        signature_only: rpc({ args: { id: 'uuid' }, returns: 'text' }),
      },
    });

    const outputs = adapter.generateRpcs(schema);
    expect(outputs).toHaveLength(0);
  });

  it('should generate SQL for multiple RPCs', () => {
    const schema = defineSchema({
      users: table({ columns: { id: 'uuid' } }),
    }, {
      rpcs: {
        fn_a: rpc({ returns: 'text', body: `RETURN 'a';` }),
        fn_b: rpc({ args: { x: 'int' }, returns: 'int', body: `RETURN x * 2;` }),
      },
    });

    const sql = adapter.generateRpcs(schema)[0].content;
    expect(sql).toContain('CREATE OR REPLACE FUNCTION fn_a()');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION fn_b(x INTEGER)');
  });

  it('should return empty for schema without RPCs', () => {
    const schema = defineSchema({
      users: table({ columns: { id: 'uuid' } }),
    });

    const outputs = adapter.generateRpcs(schema);
    expect(outputs).toHaveLength(0);
  });

  it('should handle void return type', () => {
    const schema = defineSchema({
      users: table({ columns: { id: 'uuid' } }),
    }, {
      rpcs: {
        do_nothing: rpc({
          returns: 'void',
          body: `-- noop`,
        }),
      },
    });

    const sql = adapter.generateRpcs(schema)[0].content;
    expect(sql).toContain('RETURNS VOID');
  });
});

describe('Supabase Adapter — RPC Client Generation (manual mode)', () => {
  const adapter = new SupabaseAdapter({ timestamps: false });

  it('should include rpc namespace in generated client', () => {
    const schema = defineSchema({
      users: table({ columns: { id: 'uuid', name: 'text' } }),
    }, {
      rpcs: {
        get_stats: rpc({ args: { user_id: 'uuid' }, returns: 'jsonb' }),
      },
    });

    const outputs = adapter.generateClient(schema);
    const client = outputs.find(o => o.path === 'client.ts')!;

    expect(client.content).toContain('rpc: {');
    expect(client.content).toContain("type Functions = Database['public']['Functions'];");
    expect(client.content).toContain("get_stats: (args: Functions['get_stats']['Args'])");
    expect(client.content).toContain("provider.rpc('get_stats', args)");
  });

  it('makes the args of a no-arg RPC optional and lint-clean', () => {
    const schema = defineSchema({
      users: table({ columns: { id: 'uuid' } }),
    }, {
      rpcs: {
        hello: rpc({ returns: 'text' }),
      },
    });

    const client = adapter.generateClient(schema).find(o => o.path === 'client.ts')!;
    expect(client.content).toContain("hello: (args: Functions['hello']['Args'] = {})");
    const types = adapter.generateClient(schema).find(o => o.path === 'types.ts')!;
    expect(types.content).toContain('Args: Record<string, never>;');
    expect(client.content).not.toMatch(/\bany\b/);
  });

  it('should not include rpc namespace when no RPCs', () => {
    const schema = defineSchema({
      users: table({ columns: { id: 'uuid' } }),
    });

    const client = adapter.generateClient(schema).find(o => o.path === 'client.ts')!;
    expect(client.content).not.toContain('\n    rpc: {');
    expect(client.content).not.toContain('provider.rpc(');
  });
});

describe('Supabase Adapter — RPC Client Generation (Database mode)', () => {
  it('should include rpc namespace using Functions type', () => {
    const adapter = new SupabaseAdapter({
      timestamps: false,
      databaseTypes: './database.types',
    });

    // Simulate Database mode: tables with empty columns + RPCs
    const schema = defineSchema({
      users: table({ columns: {} as any }),
    }, {
      rpcs: {
        get_stats: rpc(),
        search_users: rpc(),
      },
    });

    const outputs = adapter.generateClient(schema);
    expect(outputs).toHaveLength(1);

    const client = outputs[0];
    expect(client.content).toContain("type Functions = Database['public']['Functions'];");
    expect(client.content).toContain('rpc: {');
    expect(client.content).toContain("get_stats: (args: Functions['get_stats']['Args'])");
    expect(client.content).toContain("provider.rpc('get_stats', args)");
    expect(client.content).toContain("search_users: (args: Functions['search_users']['Args'])");
    expect(client.content).toContain("provider.rpc('search_users', args)");
  });

  it('should not include Functions type when no RPCs in Database mode', () => {
    const adapter = new SupabaseAdapter({
      timestamps: false,
      databaseTypes: './database.types',
    });

    const schema = defineSchema({
      users: table({ columns: {} as any }),
    });

    const client = adapter.generateClient(schema)[0];
    // Only emitted when used (typescript-eslint flags an unused type alias).
    expect(client.content).not.toContain("type Functions = Database['public']['Functions'];");
    expect(client.content).not.toContain('\n    rpc: {');
    expect(client.content).not.toContain('provider.rpc(');
  });
});

describe('definer RPC privileges', () => {
  const adapter = new SupabaseAdapter({ timestamps: false });
  const sqlFor = (extra: Record<string, unknown>) => adapter.generateRpcs(defineSchema({
    notes: table({ columns: { id: 'uuid' }, primaryKey: 'id' }),
  }, {
    rpcs: { accept: rpc({ args: { p_token: 'text', p_n: 'int' }, returns: 'uuid', body: 'RETURN NULL;', ...extra }) },
  }))[0].content;

  it('revokes EXECUTE from PUBLIC and anon on SECURITY DEFINER functions', () => {
    const sql = sqlFor({ security: 'definer' });
    expect(sql).toContain('REVOKE EXECUTE ON FUNCTION accept(TEXT, INTEGER) FROM PUBLIC, anon;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION accept(TEXT, INTEGER) TO authenticated, service_role;');
  });

  it('keeps anon with allowAnon, and leaves invoker functions alone', () => {
    const open = sqlFor({ security: 'definer', allowAnon: true });
    expect(open).toContain('REVOKE EXECUTE ON FUNCTION accept(TEXT, INTEGER) FROM PUBLIC;');
    expect(open).toContain('TO authenticated, service_role, anon;');
    expect(sqlFor({})).not.toContain('EXECUTE ON FUNCTION');
  });
});

describe('RPC table/setof returns', () => {
  const adapter = new SupabaseAdapter({ deterministic: true });
  const schema = defineSchema({
    bookings: table({ columns: { id: 'uuid', client_id: 'uuid', note: 'text?' }, primaryKey: 'id' }),
  }, {
    rpcs: {
      get_client_bookings: rpc({
        args: { p_client_id: 'uuid' },
        returns: { table: { booking_id: 'uuid', date_time: 'timestamptz', services: 'json', has_review: 'boolean', total: 'numeric', note: 'text?' } },
        language: 'sql',
        security: 'definer',
        body: 'SELECT id, now(), null::json, false, 0::numeric, note FROM bookings WHERE client_id = p_client_id;',
      }),
      bookings_of: rpc({ args: { p_client_id: 'uuid' }, returns: { setof: 'bookings' }, language: 'sql', body: 'SELECT * FROM bookings WHERE client_id = p_client_id;' }),
      booking_ids: rpc({ returns: { setof: 'uuid' }, language: 'sql', body: 'SELECT id FROM bookings;' }),
      signature_only: rpc({ args: { p_id: 'uuid' }, returns: { table: { n: 'int' } } }),
    },
  });

  it('emits RETURNS TABLE(...) / SETOF and skips signature-only rpcs', () => {
    const sql = adapter.generateRpcs(schema)[0].content;
    expect(sql).toContain('CREATE OR REPLACE FUNCTION get_client_bookings(p_client_id UUID)\nRETURNS TABLE(booking_id UUID, date_time TIMESTAMPTZ, services JSON, has_review BOOLEAN, total NUMERIC, note TEXT)');
    expect(sql).toContain('RETURNS SETOF bookings');
    expect(sql).toContain('RETURNS SETOF UUID');
    expect(sql).not.toContain('signature_only');
    expect(sql).toContain('REVOKE EXECUTE ON FUNCTION get_client_bookings(UUID) FROM PUBLIC, anon;');
  });

  it('guards CREATE OR REPLACE with a DROP when the result or arg names change', () => {
    const sql = adapter.generateRpcs(schema)[0].content;
    expect(sql).toContain("fn regprocedure := pg_catalog.to_regprocedure('get_client_bookings(UUID)');");
    expect(sql).toContain("want_args text := 'p_client_id ' || pg_catalog.format_type(pg_catalog.to_regtype('UUID'), NULL);");
    expect(sql).toContain("want_result text := 'TABLE(' || 'booking_id ' || pg_catalog.format_type(pg_catalog.to_regtype('UUID'), NULL) || ', date_time ' ||");
    expect(sql).toContain("want_result text := 'SETOF ' || pg_catalog.format_type(pg_catalog.to_regtype('bookings'), NULL);");
    expect(sql).toContain('    DROP FUNCTION get_client_bookings(UUID);');
    expect(sql).not.toMatch(/DROP FUNCTION[^;]*CASCADE/);
  });

  it('types TABLE/SETOF results like supabase gen types', () => {
    const types = adapter.generateClient(schema).find((f) => f.path === 'types.ts')!.content;
    expect(types).toContain('Args: { p_client_id: string };\n        Returns: { booking_id: string; date_time: string; services: Json; has_review: boolean; total: number; note: string | null }[];');
    expect(types).toContain('Returns: Bookings[];');
    expect(types).toContain('Returns: string[];');
  });

  it('rejects an empty returns.table', () => {
    const bad = defineSchema({ t: table({ columns: { id: 'uuid' } }) }, {
      rpcs: { f: rpc({ returns: { table: {} }, body: 'SELECT 1' }) },
    });
    expect(() => adapter.generateRpcs(bad)).toThrow(/at least one column/);
  });
});
