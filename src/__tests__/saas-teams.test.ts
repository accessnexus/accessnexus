import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { SupabaseAdapter } from '../adapters/supabase/adapter.js';
import { checkSchema } from '../cli/schema-check.js';
import { defineSchema, table } from '../core/schema/builders.js';
import { definePermissions } from '../core/permissions/builders.js';
import { defineEnum } from '../core/enum/builders.js';
import { policy } from '../core/policy/builders.js';
import { trigger } from '../core/triggers/builders.js';
import { tenantInvitations } from '../core/tenancy/builders.js';
import schema from '../../examples/saas-teams/accessnexus.schema.js';

// The multi-tenant builders, statically: examples/saas-teams validates clean and
// generates what its integration test (saas-teams.integration.test.ts) relies on.

const root = join(import.meta.dirname, '..', '..');
const cacheDir = join(root, 'node_modules', '.cache');
mkdirSync(cacheDir, { recursive: true });
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const adapter = () => new SupabaseAdapter({ deterministic: true, reactQuery: true });

describe('examples/saas-teams', () => {
  it('validates with no errors and no warnings', () => {
    expect(checkSchema(schema)).toEqual([]);
  });

  it('declares member_role once and uses it everywhere (no per-column enum, no casts)', () => {
    const sql = adapter().generateMigrations(schema)[0].content;
    expect(sql.match(/CREATE TYPE member_role AS ENUM \('owner', 'admin', 'member', 'viewer'\)/g)).toHaveLength(1);
    expect(sql).toContain('role member_role NOT NULL');
    expect(sql).not.toMatch(/org_members_role_enum|invitations_role_enum/);
    const rpcs = adapter().generateRpcs(schema)[0].content;
    expect(rpcs).toContain('RETURNS TABLE(user_id UUID, role member_role, display_name TEXT, joined_at TIMESTAMPTZ)');
    expect(rpcs).toContain('v_role::public.member_role');
  });

  it('types the shared enum and column references in the SDK', () => {
    const dir = mkdtempSync(join(cacheDir, 'accessnexus-saas-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    for (const f of adapter().generateClient(schema)) writeFileSync(join(dir, f.path), f.content);
    writeFileSync(join(dir, 'use.ts'), `
import type { Database } from './types.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const assertType = <T extends true>(value: T): T => value;
type Role = 'owner' | 'admin' | 'member' | 'viewer';
type Fns = Database['public']['Functions'];
assertType<Equal<Database['public']['Enums']['member_role'], Role>>(true);
assertType<Equal<Database['public']['Tables']['org_members']['Row']['role'], Role>>(true);
assertType<Equal<Fns['org_people']['Returns'][number]['role'], Role>>(true);
assertType<Equal<Fns['my_invitations']['Returns'][number]['role'], Role>>(true);
`);
    const program = ts.createProgram([join(dir, 'use.ts')], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true,
    });
    expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  }, 60_000);

  it('React Query: orgs.create also refreshes org_members (trigger.custom writes)', () => {
    const rq = adapter().generateClient(schema).find((f) => f.path === 'react-query.ts')!.content;
    const orgs = rq.slice(rq.indexOf('    orgs: {'), rq.indexOf('    org_members: {'));
    expect(orgs).toContain('onSuccess: invalidate(accessNexusKeys.orgs.all, accessNexusKeys.org_members.all');
  });
});

describe('definePermissions { all: [...] }', () => {
  it('ANDs levels', () => {
    const perms = definePermissions({
      roles: ['member'],
      tenant: { table: 'm', userColumn: 'user_id', tenantColumn: 'org_id', roleColumn: 'role' },
      resources: { t: { ownerColumn: 'user_id', tenantColumn: 'org_id', delete: { all: ['own', { scope: 'tenant', roles: ['member'] }] } } },
    });
    const rule = perms.policiesFor('t').delete as any;
    expect(rule.kind).toBe('all');
    expect(rule.rules.map((r: any) => r.kind)).toEqual(['owner', 'belongs_to']);
    expect(() => definePermissions({ roles: [], resources: { t: { delete: { all: [] } } } } as any).policiesFor('t')).toThrow(/at least one level/);
  });
});

describe('builders: validate checks', () => {
  const codes = (s: unknown) => checkSchema(s).map((i) => `${i.severity}:${i.code}:${i.path}`);

  it('reports unknown enums, columns and tables in the new builders', () => {
    const role = defineEnum('member_role', ['a']);
    const found = codes(defineSchema({
      m: table({ columns: { id: 'uuid', org_id: 'uuid', user_id: 'uuid', role: role.type, kind: 'enum:nope' }, primaryKey: 'id',
        triggers: [trigger.keepAtLeastOne({ column: 'rolee', value: 'a', scope: 'org_id', parent: 'orgs.id' })] }),
      t: table({ columns: { id: 'uuid', org_id: 'uuid', p_id: 'uuid?' }, primaryKey: 'id',
        triggers: [
          trigger.sameTenant({ column: 'p_id', references: 'ghost', tenantColumn: 'org_id' }),
          trigger.memberOfTenant({ column: 'nope', tenant: { table: 'm', userColumn: 'user_id', tenantColumn: 'org_id' } }),
          trigger.onAuthUserCreated({ columns: { missing: 'NEW.id' } }),
          trigger.custom({ name: 'x', events: ['after_insert'], functionBody: 'RETURN NEW;', writes: ['ghost'] }),
        ],
        policies: { select: policy.sharesTenant('id', { table: 'm', userColumn: 'user_idd', tenantColumn: 'org_id' }) } }),
    }, { enums: [role] }));
    expect(found).toEqual(expect.arrayContaining([
      'error:UNKNOWN_ENUM:m.columns.kind',
      'error:UNKNOWN_COLUMN:m.triggers[0]',
      'error:UNKNOWN_TABLE:m.triggers[0]',
      'error:UNKNOWN_TABLE:t.triggers[0]',
      'error:UNKNOWN_COLUMN:t.triggers[1]',
      'error:UNKNOWN_COLUMN:t.triggers[2]',
      'error:UNKNOWN_TABLE:t.triggers[3].writes',
      'error:UNKNOWN_COLUMN:t.policies.select',
    ]));
  });

  it('tenantInvitations: hand-out rules per inviter role', () => {
    const inv = tenantInvitations({
      tenant: { table: 'org_members', userColumn: 'user_id', tenantColumn: 'org_id', roleColumn: 'role' },
      tenantTable: 'orgs',
      roles: ['admin', 'member'],
      inviterRoles: { owner: ['admin', 'member'], admin: ['member'] },
      requireConfirmedEmail: false,
      rpcNames: { accept: 'join_org', mine: 'pending_invites' },
    });
    expect(Object.keys(inv.rpcs)).toEqual(['join_org', 'pending_invites']);
    expect((inv.rpcs.join_org as any).body).not.toContain('email_confirmed_at');
    expect((inv.rpcs.join_org as any).body).toContain('v_role::public.org_members_role_enum');
    const sql = new SupabaseAdapter({ deterministic: true }).generatePolicies(defineSchema({
      orgs: table({ columns: { id: 'uuid' }, primaryKey: 'id' }),
      org_members: table({ columns: { id: 'uuid', org_id: 'uuid', user_id: 'uuid', role: "enum('owner','admin','member')" }, primaryKey: 'id' }),
      invitations: inv.table,
    })).find((f) => f.path === 'invitations_rls.sql')!.content;
    expect(sql).toContain("(role IN ('member'))");
    expect(sql).toContain("(role IN ('admin', 'member'))");
    expect(sql).toMatch(/accessnexus_invitations_update"\n {2}ON invitations FOR UPDATE\n {2}TO authenticated\n {2}USING \(\n {4}FALSE/);
  });
});
