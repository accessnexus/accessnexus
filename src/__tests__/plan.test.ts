import { describe, expect, it } from 'vitest';
import {
  captureSnapshot,
  decodeTriggerType,
  diffSnapshots,
  findRiskyChanges,
  functionsDefinedIn,
  renderPlan,
  summarizeChanges,
  type CatalogSnapshot,
  type PlanKind,
} from '../cli/plan.js';

function snap(...entries: Array<[PlanKind, string, Record<string, unknown>]>): CatalogSnapshot {
  const out: CatalogSnapshot = {};
  for (const [kind, object, props] of entries) out[`${kind}:${object}`] = { kind, object, props };
  return out;
}

const fn = (props: Record<string, unknown> = {}) => ({
  returns: 'integer', language: 'sql', volatility: 'VOLATILE', securityDefiner: false, strict: false,
  config: ['search_path=pg_catalog, public'], bodyHash: 'a', definition: 'CREATE FUNCTION ...', ...props,
});
const pol = (props: Record<string, unknown> = {}) => ({
  command: 'SELECT', permissive: true, roles: ['authenticated'], using: '(owner_id = ( SELECT auth.uid() AS uid))', withCheck: null, ...props,
});

describe('functionsDefinedIn', () => {
  it('finds schema-qualified, unqualified and quoted function names', () => {
    const sql = `
      CREATE OR REPLACE FUNCTION note_count() RETURNS int AS $$ SELECT 1 $$;
      create function private.is_member(uuid) returns boolean as $$ select true $$;
      CREATE FUNCTION "Weird"."MixedCase"(x int) RETURNS int AS $$ SELECT x $$;
      CREATE OR REPLACE FUNCTION note_count() RETURNS int AS $$ SELECT 2 $$;`;
    expect(functionsDefinedIn(sql)).toEqual([
      { schema: 'public', name: 'note_count' },
      { schema: 'private', name: 'is_member' },
      { schema: 'Weird', name: 'MixedCase' },
    ]);
    expect(functionsDefinedIn('CREATE FUNCTION Foo() ...', 'app')).toEqual([{ schema: 'app', name: 'foo' }]);
  });
});

describe('decodeTriggerType', () => {
  it('decodes timing, events and level from tgtype', () => {
    // BEFORE (2) | ROW (1) | INSERT (4) | UPDATE (16)
    expect(decodeTriggerType(2 | 1 | 4 | 16)).toEqual({ timing: 'BEFORE', events: ['INSERT', 'UPDATE'], level: 'ROW' });
    expect(decodeTriggerType(8)).toEqual({ timing: 'AFTER', events: ['DELETE'], level: 'STATEMENT' });
    expect(decodeTriggerType(64 | 1 | 4).timing).toBe('INSTEAD OF');
  });
});

describe('diffSnapshots', () => {
  it('reports added, removed and modified objects with the differing fields', () => {
    const before = snap(
      ['table', 'public.notes', {}],
      ['policy', 'public.notes.p_select', pol()],
      ['policy', 'public.notes.legacy', pol({ roles: ['public'], using: 'true' })],
    );
    const after = snap(
      ['table', 'public.notes', {}],
      ['policy', 'public.notes.p_select', pol({ using: 'true' })],
      ['column', 'public.notes.body', { type: 'text', notNull: false, default: null, identity: null, generated: null }],
    );
    const changes = diffSnapshots(before, after);
    expect(changes.map((c) => [c.kind, c.object, c.change])).toEqual([
      ['column', 'public.notes.body', 'added'],
      ['policy', 'public.notes.legacy', 'removed'],
      ['policy', 'public.notes.p_select', 'modified'],
    ]);
    expect(changes[2].fields).toEqual(['using']);
    expect(summarizeChanges(changes)).toEqual({ added: 1, modified: 1, removed: 1 });
  });

  it('identical snapshots (role order aside — roles are sorted at capture) give no changes', () => {
    const a = snap(['function', 'public.f()', fn()], ['rls', 'public.notes', { enabled: true, forced: true }]);
    expect(diffSnapshots(a, JSON.parse(JSON.stringify(a)))).toEqual([]);
  });

  it('does not compare the function definition text (bodyHash and attributes cover it)', () => {
    const changes = diffSnapshots(snap(['function', 'public.f()', fn()]), snap(['function', 'public.f()', fn({ definition: 'other' })]));
    expect(changes).toEqual([]);
  });
});

describe('findRiskyChanges', () => {
  it('flags volatility, config and security changes on functions', () => {
    const changes = diffSnapshots(
      snap(['function', 'public.f()', fn({ volatility: 'STABLE', config: ['search_path=public'], securityDefiner: true })]),
      snap(['function', 'public.f()', fn()]),
    );
    expect(findRiskyChanges(changes).map((r) => r.code)).toEqual([
      'function_volatility_changed', 'function_config_changed', 'function_security_changed',
    ]);
  });

  it('flags widened policy roles, dropped policies and permissive flips — not narrowed roles', () => {
    const before = snap(
      ['policy', 'public.t.wide', pol()],
      ['policy', 'public.t.narrow', pol({ roles: ['public'] })],
      ['policy', 'public.t.gone', pol()],
      ['policy', 'public.t.flip', pol({ permissive: false })],
    );
    const after = snap(
      ['policy', 'public.t.wide', pol({ roles: ['public'] })],
      ['policy', 'public.t.narrow', pol()],
      ['policy', 'public.t.flip', pol()],
    );
    const risky = findRiskyChanges(diffSnapshots(before, after));
    expect(risky.map((r) => [r.code, r.object])).toEqual([
      ['policy_permissive_changed', 'public.t.flip'],
      ['policy_dropped', 'public.t.gone'],
      ['policy_roles_widened', 'public.t.wide'],
    ]);
    expect(risky[2].message).toContain('authenticated → public');
  });

  it('flags column type changes, lost defaults, relaxed NOT NULL and dropped columns (not under a dropped table)', () => {
    const col = (props: Record<string, unknown> = {}) => ({ type: 'uuid', notNull: true, default: 'gen_random_uuid()', identity: null, generated: null, ...props });
    const before = snap(
      ['column', 'public.a.id', col()],
      ['column', 'public.a.n', col({ type: 'integer', default: null })],
      ['column', 'public.a.gone', col()],
      ['table', 'public.b', {}],
      ['column', 'public.b.id', col()],
    );
    const after = snap(
      ['column', 'public.a.id', col({ default: null, notNull: false })],
      ['column', 'public.a.n', col({ type: 'bigint', default: null })],
    );
    const codes = findRiskyChanges(diffSnapshots(before, after)).map((r) => `${r.code} ${r.object}`);
    expect(codes).toEqual([
      'table_dropped public.b',
      'column_dropped public.a.gone',
      'column_default_removed public.a.id',
      'column_nullability_relaxed public.a.id',
      'column_type_changed public.a.n',
    ]);
  });

  it('flags RLS being disabled or unforced, and grants widened to anon/PUBLIC on existing objects', () => {
    const before = snap(
      ['rls', 'public.a', { enabled: true, forced: true }],
      ['rls', 'public.b', { enabled: true, forced: true }],
      ['grant', 'function public.f()', { privileges: ['postgres=EXECUTE'], effective: [] }],
    );
    const after = snap(
      ['rls', 'public.a', { enabled: false, forced: false }],
      ['rls', 'public.b', { enabled: true, forced: false }],
      ['grant', 'function public.f()', { privileges: ['PUBLIC=EXECUTE', 'anon=EXECUTE', 'postgres=EXECUTE'], effective: ['PUBLIC=EXECUTE', 'anon=EXECUTE'] }],
      ['grant', 'function public.g()', { privileges: ['PUBLIC=EXECUTE'], effective: ['PUBLIC=EXECUTE'] }],
    );
    const risky = findRiskyChanges(diffSnapshots(before, after));
    expect(risky.map((r) => `${r.code} ${r.object}`)).toEqual([
      'rls_disabled public.a',
      'rls_disabled public.b',
      'grant_widened function public.f()',
    ]);
  });
});

describe('findRiskyChanges on effective grants', () => {
  const g = (privileges: string[], effective: string[]): [PlanKind, string, Record<string, unknown>] => ['grant', 'function public.f()', { privileges, effective }];

  it('does not flag anon moving from PUBLIC to a direct grant (no change in access), and notes it', () => {
    const changes = diffSnapshots(
      snap(g(['PUBLIC=EXECUTE', 'postgres=EXECUTE'], ['PUBLIC=EXECUTE', 'anon=EXECUTE', 'authenticated=EXECUTE'])),
      snap(g(['anon=EXECUTE', 'authenticated=EXECUTE', 'postgres=EXECUTE'], ['anon=EXECUTE', 'authenticated=EXECUTE'])),
    );
    const risky = findRiskyChanges(changes);
    // PUBLIC lost its entry, but anon and authenticated keep EXECUTE: not risky.
    expect(risky).toEqual([]);
    expect(changes[0].notes).toContain('PUBLIC EXECUTE: granted → none (PUBLIC entry removed; see anon/authenticated)');
    expect(changes[0].notes).toContain('anon EXECUTE: via PUBLIC → direct grant (no change in access)');
    const text = renderPlan(changes, risky).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    expect(text).toContain('anon EXECUTE: via PUBLIC → direct grant (no change in access)');
  });

  it('flags anon / authenticated losing effective access as grant_narrowed', () => {
    const risky = findRiskyChanges(diffSnapshots(
      snap(g(['PUBLIC=EXECUTE', 'postgres=EXECUTE'], ['PUBLIC=EXECUTE', 'anon=EXECUTE', 'authenticated=EXECUTE'])),
      snap(g(['PUBLIC=EXECUTE', 'postgres=EXECUTE', 'authenticated=EXECUTE'], ['PUBLIC=EXECUTE', 'authenticated=EXECUTE'])),
    ));
    expect(risky.map((r) => `${r.code} ${r.message}`)).toEqual([
      'grant_narrowed function public.f() loses access: anon EXECUTE: via PUBLIC → none',
    ]);
  });

  it('flags PUBLIC losing a privilege anon or authenticated does not keep', () => {
    const risky = findRiskyChanges(diffSnapshots(
      snap(g(['PUBLIC=EXECUTE'], ['PUBLIC=EXECUTE', 'anon=EXECUTE', 'authenticated=EXECUTE'])),
      snap(g(['postgres=EXECUTE', 'authenticated=EXECUTE'], ['authenticated=EXECUTE'])),
    ));
    expect(risky.map((r) => r.message)).toEqual([
      'function public.f() loses access: PUBLIC EXECUTE: granted → none; anon EXECUTE: via PUBLIC → none',
    ]);
  });

  it('flags table privileges lost or gained by anon', () => {
    const t = (effective: string[]): [PlanKind, string, Record<string, unknown>] => ['grant', 'table public.t', { privileges: [], effective }];
    const risky = findRiskyChanges(diffSnapshots(snap(t(['anon=SELECT'])), snap(t(['anon=INSERT']))));
    expect(risky.map((r) => r.code).sort()).toEqual(['grant_narrowed', 'grant_widened']);
  });
});

describe('renderPlan', () => {
  it('groups by kind and prints modified fields as before → after, risky last', () => {
    const changes = diffSnapshots(
      snap(['function', 'public.f()', fn({ volatility: 'STABLE' })]),
      snap(['function', 'public.f()', fn({ bodyHash: 'b' })], ['policy', 'public.t.p', pol()]),
    );
    const text = renderPlan(changes, findRiskyChanges(changes)).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    expect(text).toContain('Policies:\n    + public.t.p (SELECT to authenticated)');
    expect(text).toContain('~ public.f() (risky)\n        volatility: STABLE → VOLATILE\n        body: changed');
    expect(text).toContain('Risky changes: 1');
    expect(text).toContain('[function_volatility_changed]');
  });
});

describe('captureSnapshot', () => {
  it('normalizes catalog rows (roles sorted, codes decoded) from a stubbed client', async () => {
    const client = {
      async query(sql: string): Promise<{ rows: any[] }> {
        if (sql.includes('FROM pg_catalog.pg_class c') && sql.includes("relkind IN ('r', 'p')")) {
          return { rows: [{ oid: 1, nspname: 'public', relname: 'notes', relrowsecurity: true, relforcerowsecurity: false, privileges: '{postgres=SELECT,anon=SELECT}', effective: '{anon=SELECT}' }] };
        }
        if (sql.includes('pg_catalog.pg_policy')) {
          return { rows: [{ nspname: 'public', relname: 'notes', polname: 'p', polcmd: 'r', polpermissive: true, roles: ['authenticated', 'anon'], using_expr: 'true', check_expr: null }] };
        }
        if (sql.includes('pg_catalog.pg_trigger')) {
          return { rows: [{ nspname: 'public', relname: 'notes', tgname: 't', tgtype: 2 | 1 | 4, tgenabled: 'O', tgfoid: 9, function: 'public.trg()', def: 'CREATE TRIGGER t BEFORE INSERT ON public.notes FOR EACH ROW WHEN ((new.body IS NOT NULL)) EXECUTE FUNCTION public.trg()' }] };
        }
        if (sql.includes('pg_catalog.pg_proc')) {
          return { rows: [{ nspname: 'public', proname: 'trg', args: '', returns: 'trigger', lanname: 'plpgsql', provolatile: 'v', prosecdef: true, proisstrict: false, proconfig: ['search_path=pg_catalog, public'], body_hash: 'h', def: 'def', privileges: [] }] };
        }
        return { rows: [] };
      },
    };
    const s = await captureSnapshot(client, { tables: [{ schema: 'public', table: 'notes' }], functions: [] });
    expect(s['rls:public.notes'].props).toEqual({ enabled: true, forced: false });
    expect(s['grant:table public.notes'].props).toEqual({ privileges: ['anon=SELECT', 'postgres=SELECT'], effective: ['anon=SELECT'] });
    expect(s['policy:public.notes.p'].props).toMatchObject({ command: 'SELECT', roles: ['anon', 'authenticated'] });
    expect(s['trigger:public.notes.t'].props).toEqual({
      timing: 'BEFORE', events: ['INSERT'], level: 'ROW', when: '(new.body IS NOT NULL)', function: 'public.trg()', enabled: true,
    });
    expect(s['function:public.trg()'].props).toMatchObject({ volatility: 'VOLATILE', securityDefiner: true, config: ['search_path=pg_catalog, public'] });
  });
});
