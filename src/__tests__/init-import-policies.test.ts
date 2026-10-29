import { describe, it, expect } from 'vitest';
import { generateSchemaFromIntrospection, importPolicies } from '../cli/init/schema-gen.js';
import type { IntrospectedPolicy, IntrospectedTable } from '../cli/init/introspect.js';
import { SupabaseAdapter } from '../adapters/supabase/adapter.js';
import { defineSchema, table } from '../core/schema/builders.js';
import { policy } from '../core/policy/builders.js';
import type { PolicyRule } from '../core/types/policy.js';

const pol = (p: Partial<IntrospectedPolicy> & Pick<IntrospectedPolicy, 'policyname' | 'cmd'>): IntrospectedPolicy => ({
  tablename: 't',
  qual: null,
  with_check: null,
  roles: ['public'],
  permissive: 'PERMISSIVE',
  ...p,
});

/** Evaluate an imported rule's source the way the user's schema file would. */
const evalRule = (src: string): PolicyRule => new Function('policy', `return (${src});`)(policy);

/** Imported rules → the generated policy SQL for a table. */
function generatedSql(policies: IntrospectedPolicy[], rlsEnabled = true): string {
  const imported = importPolicies({ policies, rlsEnabled }) ?? {};
  const rules = Object.fromEntries(Object.entries(imported).map(([op, e]) => [op, evalRule(e!.rule)]));
  const adapter = new SupabaseAdapter({ policyPrefix: 'accessnexus', timestamps: false });
  const out = adapter.generatePolicies(defineSchema({
    secrets: table({ columns: { id: 'uuid', user_id: 'uuid', tenant: 'text', value: 'text' }, primaryKey: 'id', policies: rules }),
  }));
  return out[0]?.content ?? '';
}

describe('init --db-url policy import (fail closed)', () => {
  it('maps a service_role-only policy to policy.none(), never policy.public()', () => {
    const policies = [pol({ policyname: 'service only', cmd: 'ALL', qual: 'true', with_check: 'true', roles: ['service_role'] })];
    const imported = importPolicies({ policies, rlsEnabled: true })!;
    for (const op of ['select', 'insert', 'update', 'delete'] as const) {
      expect(imported[op]!.rule).toBe('policy.none()');
      expect(imported[op]!.notes.join('\n')).toContain('service_role bypasses RLS');
    }
    const sql = generatedSql(policies);
    expect(sql).not.toMatch(/TO public/);
    expect(sql).not.toMatch(/USING \(TRUE\)|WITH CHECK \(TRUE\)/i);
  });

  it('adds the signed-in requirement for TO authenticated policies', () => {
    const policies = [
      pol({ policyname: 'auth read', cmd: 'SELECT', qual: 'true', roles: ['authenticated'] }),
      pol({ policyname: 'auth tenant', cmd: 'DELETE', qual: "(tenant = 'a'::text)", roles: ['authenticated'] }),
    ];
    const imported = importPolicies({ policies, rlsEnabled: true })!;
    expect(imported.select!.rule).toBe('policy.isAuthenticated()');
    expect(imported.delete!.rule).toBe("policy.all([policy.isAuthenticated(), policy.custom(`(tenant = 'a'::text)`)])");
    // Operations no policy mentions stay denied (absent → no policy → RLS denies).
    expect(imported.insert).toBeUndefined();
    const sql = generatedSql(policies);
    expect(sql).not.toMatch(/TO public/);
  });

  it('keeps a TO public permissive policy as is', () => {
    const imported = importPolicies({
      policies: [pol({ policyname: 'read all', cmd: 'SELECT', qual: 'true' })],
      rlsEnabled: true,
    })!;
    expect(imported.select!.rule).toBe('policy.public()');
  });

  it('AND-s restrictive policies into the permissive rule instead of OR-ing them', () => {
    const policies = [
      pol({ policyname: 'owner', cmd: 'SELECT', qual: '(auth.uid() = user_id)' }),
      pol({ policyname: 'docs public', cmd: 'SELECT', qual: 'true' }),
      pol({ policyname: 'tenant_ok', cmd: 'ALL', qual: "(tenant = 'a'::text)", permissive: 'RESTRICTIVE' }),
    ];
    const imported = importPolicies({ policies, rlsEnabled: true })!;
    const rule = imported.select!.rule;
    expect(rule.startsWith('policy.all([')).toBe(true);
    expect(rule).toContain('policy.any([');
    expect(rule).toContain("policy.custom(`(tenant = 'a'::text)`)");
    const sql = generatedSql(policies).split('FOR SELECT')[1];
    expect(sql).toMatch(/AND/);
    // The restrictive filter is an AND, so it is never a branch of the OR.
    expect(evalRule(rule).kind).toBe('all');
    // A restrictive policy alone grants nothing.
    const onlyRestrictive = importPolicies({ policies: [policies[2]], rlsEnabled: true })!;
    expect(onlyRestrictive.select!.rule).toBe('policy.none()');
  });

  it('skips an anon-only permissive policy with a TODO (denied)', () => {
    const imported = importPolicies({
      policies: [pol({ policyname: 'anon read', cmd: 'SELECT', qual: 'true', roles: ['anon'] })],
      rlsEnabled: true,
    })!;
    expect(imported.select!.rule).toBe('policy.none()');
    expect(imported.select!.notes.join('\n')).toContain('TODO');
  });

  it('denies everything when RLS is on with no policies, and imports nothing when RLS is off', () => {
    const on = importPolicies({ policies: [], rlsEnabled: true })!;
    expect(Object.values(on).map((e) => e!.rule)).toEqual(Array(4).fill('policy.none()'));
    expect(importPolicies({ policies: [], rlsEnabled: false })).toBeNull();
  });

  it('keeps a distinct UPDATE WITH CHECK as the only check on the new row', () => {
    const imported = importPolicies({
      policies: [pol({ policyname: 'upd', cmd: 'UPDATE', qual: '(auth.uid() = user_id)', with_check: "(tenant = 'a'::text)" })],
      rlsEnabled: true,
    })!;
    expect(imported.update!.rule).toBe("policy.withCheck(policy.isOwner('user_id'), policy.custom(`(tenant = 'a'::text)`), { mode: 'replace' })");
  });

  it('writes the notes as comments in accessnexus.schema.ts', () => {
    const tables: IntrospectedTable[] = [{
      name: 'secrets',
      columns: [{ column_name: 'id', udt_name: 'uuid', is_nullable: 'NO', column_default: null } as any],
      primaryKey: 'id',
      foreignKeys: [],
      uniqueColumns: [],
      rlsEnabled: true,
      policies: [pol({ tablename: 'secrets', policyname: 'service only', cmd: 'ALL', qual: 'true', with_check: 'true', roles: ['service_role'] })],
    }];
    const src = generateSchemaFromIntrospection({ tables, policyPrefix: 'accessnexus' });
    expect(src).toContain('select: policy.none(),');
    expect(src).toContain('// "service only" (PERMISSIVE, ALL, TO service_role): skipped');
    expect(src).not.toContain('policy.public()');
  });

  it('keeps a table with RLS off in the database open only through an explicit enableRLS: false', () => {
    const base = {
      columns: [{ column_name: 'id', udt_name: 'uuid', is_nullable: 'NO', column_default: null } as any],
      primaryKey: 'id',
      foreignKeys: [],
      uniqueColumns: [],
      policies: [],
    };
    const off = generateSchemaFromIntrospection({ tables: [{ ...base, name: 'legacy', rlsEnabled: false }], policyPrefix: 'accessnexus' });
    expect(off).toContain('enableRLS: false,');
    expect(off).toContain('RLS is OFF in the database today');

    // REST introspection does not know the RLS state: no opt-out, the table is locked (deny-all).
    const unknown = generateSchemaFromIntrospection({ tables: [{ ...base, name: 'legacy' }], policyPrefix: 'accessnexus' });
    expect(unknown).not.toContain('enableRLS');
  });
});
