// Function fidelity: rpc() volatility and `set` (proconfig), trigger.custom
// `set`, and the search_path hardening init reports on import.
import { describe, expect, it } from 'vitest';
import { SupabaseAdapter } from '../adapters/supabase/adapter.js';
import type { IntrospectedFunction } from '../cli/init/introspect-db.js';
import { parseProconfig } from '../cli/init/introspect-db.js';
import type { IntrospectedTrigger } from '../cli/init/introspect.js';
import { generateSchemaFromIntrospection, type HardenedFunction } from '../cli/init/schema-gen.js';
import { checkSchema } from '../cli/schema-check.js';
import { defineSchema, policy, rpc, table, trigger } from '../index.js';

const adapter = new SupabaseAdapter({ deterministic: true });
const users = table({ columns: { id: 'uuid' }, primaryKey: 'id', policies: { select: policy.isAuthenticated() } });

const rpcSql = (rpcs: Record<string, ReturnType<typeof rpc>>) =>
  adapter.generateRpcs(defineSchema({ users }, { rpcs }))[0].content;

const issues = (rpcs: Record<string, unknown>) =>
  checkSchema(defineSchema({ users }, { rpcs } as any)).map((i) => `${i.severity}:${i.code}:${i.path}`);

describe('rpc volatility', () => {
  it('defaults to VOLATILE and emits stable / immutable', () => {
    const sql = rpcSql({
      v: rpc({ returns: 'int', body: 'RETURN 1;' }),
      s: rpc({ returns: 'int', body: 'RETURN 1;', volatility: 'stable' }),
      i: rpc({ returns: 'int', body: 'RETURN 1;', volatility: 'immutable' }),
      alias: rpc({ returns: 'int', body: 'RETURN 1;', immutable: true }),
    });
    const block = (name: string) => sql.split('CREATE OR REPLACE FUNCTION ').find((b) => b.startsWith(`${name}(`))!;
    expect(block('v')).toContain('\nVOLATILE\n');
    expect(block('s')).toContain('\nSTABLE\n');
    expect(block('i')).toContain('\nIMMUTABLE\n');
    expect(block('alias')).toContain('\nIMMUTABLE\n');
  });

  it('accepts immutable: true with volatility: immutable', () => {
    expect(rpcSql({ f: rpc({ returns: 'int', body: 'RETURN 1;', immutable: true, volatility: 'immutable' }) })).toContain('IMMUTABLE');
    expect(issues({ f: rpc({ returns: 'int', body: 'RETURN 1;', immutable: true, volatility: 'immutable' }) })).toEqual([]);
  });

  it('rejects conflicting immutable / volatility (validate and generate)', () => {
    const bad = { f: rpc({ returns: 'int', body: 'RETURN 1;', immutable: true, volatility: 'stable' }) };
    expect(issues(bad)).toContain('error:RPC_VOLATILITY_CONFLICT:rpcs.f.volatility');
    expect(() => rpcSql(bad)).toThrow(/conflicts/);
    const bad2 = { f: rpc({ returns: 'int', body: 'RETURN 1;', immutable: false, volatility: 'immutable' }) };
    expect(issues(bad2)).toContain('error:RPC_VOLATILITY_CONFLICT:rpcs.f.volatility');
  });

  it('rejects an unknown volatility', () => {
    const bad = { f: rpc({ returns: 'int', body: 'RETURN 1;', volatility: 'sometimes' as any }) };
    expect(issues(bad)).toContain('error:INVALID_RPC:rpcs.f.volatility');
    expect(() => rpcSql(bad)).toThrow(/volatility/);
  });
});

describe('rpc set (function config)', () => {
  it('emits SET key = quoted value, sorted, after the pinned search_path', () => {
    const sql = rpcSql({
      f: rpc({ returns: 'int', body: 'RETURN 1;', set: { work_mem: '64MB', row_security: 'off' } }),
    });
    expect(sql).toContain("SET search_path = pg_catalog, public\nSET row_security = 'off'\nSET work_mem = '64MB'\nAS $$");
  });

  it('quotes values through quoteLiteral (no injection)', () => {
    const sql = rpcSql({ f: rpc({ returns: 'int', body: 'RETURN 1;', set: { 'myapp.tag': "x'; DROP TABLE users; --" } }) });
    expect(sql).toContain("SET myapp.tag = 'x''; DROP TABLE users; --'");
  });

  it('keeps the pinned search_path and ignores set.search_path (validate warns)', () => {
    const sql = rpcSql({ f: rpc({ returns: 'int', body: 'RETURN 1;', set: { search_path: 'public' } }) });
    expect(sql).toContain('SET search_path = pg_catalog, public');
    expect(sql).not.toContain("SET search_path = 'public'");
    expect(issues({ f: rpc({ returns: 'int', body: 'RETURN 1;', set: { search_path: 'public' } }) }))
      .toContain('warning:SEARCH_PATH_PINNED:rpcs.f.set.search_path');
    expect(issues({ f: rpc({ returns: 'int', body: 'RETURN 1;', set: { search_path: 'pg_catalog, public' } }) })).toEqual([]);
  });

  it('rejects invalid GUC names and non-string values', () => {
    const bad = { f: rpc({ returns: 'int', body: 'RETURN 1;', set: { 'work_mem = 1; DROP': '1' } }) };
    expect(issues(bad)).toContain('error:INVALID_FUNCTION_SET:rpcs.f.set.work_mem = 1; DROP');
    expect(() => rpcSql(bad)).toThrow(/configuration parameter/);
    expect(issues({ f: rpc({ returns: 'int', body: 'RETURN 1;', set: { work_mem: 64 as any } }) }))
      .toContain('error:INVALID_FUNCTION_SET:rpcs.f.set.work_mem');
  });
});

describe('trigger.custom set', () => {
  it('emits SET clauses on the trigger function', () => {
    const t = table({
      columns: { id: 'uuid', name: 'text' },
      primaryKey: 'id',
      triggers: [trigger.custom({
        name: 'touch', events: ['before_update'], functionBody: 'RETURN NEW;', set: { row_security: 'off' },
      })],
    });
    const sql = adapter.triggerRuleToSQL(t.triggers![0], 'items', t);
    expect(sql).toContain("$$ LANGUAGE plpgsql\nSET row_security = 'off'\nSET search_path = pg_catalog, public;");
  });
});

describe('init import of volatility, proconfig and search_path', () => {
  it('parses proconfig entries', () => {
    expect(parseProconfig(['search_path=public', 'row_security=off', 'myapp.x=a=b'])).toEqual({
      search_path: 'public', row_security: 'off', 'myapp.x': 'a=b',
    });
    expect(parseProconfig(null)).toEqual({});
  });

  const fn = (name: string, extra: Partial<IntrospectedFunction>): IntrospectedFunction => ({
    name, args: '', returns: 'integer', language: 'sql', security: 'invoker', volatility: 'volatile', config: {}, body: 'SELECT 1', ...extra,
  });

  it('emits volatility, set and a NOTE for each function whose search_path changes', () => {
    const hardened: HardenedFunction[] = [];
    const trg: IntrospectedTrigger = {
      name: 'touch', tgtype: 1 | 2 | 16, definition: 'CREATE TRIGGER touch BEFORE UPDATE ON public.items FOR EACH ROW EXECUTE FUNCTION touch()',
      nargs: 0, updateColumns: [], isConstraint: false, enabled: 'O', functionName: 'touch', functionSchema: 'public',
      language: 'plpgsql', security: 'invoker', config: { row_security: 'off' }, body: 'BEGIN RETURN NEW; END;',
    };
    const out = generateSchemaFromIntrospection({
      policyPrefix: 'accessnexus',
      hardened,
      tables: [{ name: 'items', columns: [], foreignKeys: [], uniqueColumns: [], policies: [], triggers: [trg] }],
      functions: [
        fn('f_stable', { volatility: 'stable', config: { search_path: 'pg_catalog, public' } }),
        fn('f_immutable', { volatility: 'immutable', config: { search_path: '"pg_catalog", "public"' } }),
        fn('f_rowsec', { config: { search_path: 'public', row_security: 'off', work_mem: '64MB' } }),
        fn('f_none', {}),
      ],
    });
    expect(out).toContain("volatility: 'stable',");
    expect(out).toContain("volatility: 'immutable',");
    expect(out).toContain("set: { row_security: 'off', work_mem: '64MB' },");
    expect(out).toContain("// NOTE: search_path was 'public'; generate pins SET search_path = pg_catalog, public");
    expect(out).toContain('// NOTE: had no search_path; generate pins SET search_path = pg_catalog, public');
    expect(out).toContain("        set: { row_security: 'off' },");
    expect(hardened).toEqual([
      { kind: 'trigger', name: 'items.touch', from: null, to: 'pg_catalog, public' },
      { kind: 'rpc', name: 'f_rowsec', from: 'public', to: 'pg_catalog, public' },
      { kind: 'rpc', name: 'f_none', from: null, to: 'pg_catalog, public' },
    ]);
    // The NOTE sits right above its rpc
    expect(out).toMatch(/\/\/ NOTE: search_path was 'public'[^\n]*\n\s+f_rowsec: rpc\(\{/);
  });

  it('does not report signature-only markers (no SQL generated)', () => {
    const hardened: HardenedFunction[] = [];
    generateSchemaFromIntrospection({
      policyPrefix: 'accessnexus', hardened, tables: [{ name: 't', columns: [], foreignKeys: [], uniqueColumns: [], policies: [] }],
      functions: [fn('record_fn', { returns: 'record' })],
    });
    expect(hardened).toEqual([]);
  });
});

describe('init import of effective EXECUTE grants', () => {
  const fn = (name: string, extra: Partial<IntrospectedFunction>): IntrospectedFunction => ({
    name, args: '', returns: 'integer', language: 'sql', security: 'definer', volatility: 'stable', config: {}, body: 'SELECT 1', ...extra,
  });
  const gen = (functions: IntrospectedFunction[]) => {
    const anonExecutable: string[] = [];
    const authenticatedGranted: string[] = [];
    const out = generateSchemaFromIntrospection({
      policyPrefix: 'accessnexus', anonExecutable, authenticatedGranted,
      tables: [{ name: 't', columns: [], foreignKeys: [], uniqueColumns: [], policies: [] }],
      functions,
    });
    return { out, anonExecutable, authenticatedGranted };
  };

  it('keeps anon on a definer function anon could execute, with a NOTE, and reports it', () => {
    const { out, anonExecutable } = gen([
      fn('is_member', { anonExecute: true, authenticatedExecute: true }),
      fn('admin_only', { anonExecute: false, authenticatedExecute: true }),
      fn('invoker_fn', { security: 'invoker', anonExecute: true }),
    ]);
    expect(out).toMatch(/is_member: rpc\(\{[\s\S]*?\/\/ NOTE: anon could execute this in the source database[^\n]*\n\s+allowAnon: true,/);
    expect(out).not.toMatch(/admin_only: rpc\(\{[^}]*allowAnon/);
    expect(out).not.toMatch(/invoker_fn: rpc\(\{[^}]*allowAnon/);
    expect(anonExecutable).toEqual(['is_member']);
    const sql = rpcSql({ is_member: rpc({ returns: 'int', language: 'sql', security: 'definer', allowAnon: true, body: 'SELECT 1' }) });
    expect(sql).toContain('REVOKE EXECUTE ON FUNCTION is_member() FROM PUBLIC;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION is_member() TO authenticated, service_role, anon;');
  });

  it('notes definer functions authenticated could not execute', () => {
    const { out, authenticatedGranted } = gen([fn('svc_only', { anonExecute: false, authenticatedExecute: false })]);
    expect(out).toContain('// NOTE: authenticated could NOT execute this in the source database');
    expect(authenticatedGranted).toEqual(['svc_only']);
  });

  it('changes nothing when the roles are unknown (plain Postgres)', () => {
    const { out, anonExecutable } = gen([fn('f', {})]);
    expect(out).not.toContain('allowAnon');
    expect(anonExecutable).toEqual([]);
  });
});
