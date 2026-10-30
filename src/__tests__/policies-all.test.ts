// `policies.all`: one rule for select/insert/update/delete, per-op keys override.
// Expanded at definition time, so it emits one policy per operation and every
// check (validate warnings, foreign-policy detection, removed-op drops) sees it.
import { describe, expect, it } from 'vitest';
import { SupabaseAdapter } from '../adapters/supabase/adapter.js';
import { checkSchema } from '../cli/schema-check.js';
import { expandAllPolicy } from '../core/policy/expand.js';
import { definePermissions, defineSchema, policy, table } from '../index.js';

const adapter = new SupabaseAdapter({ deterministic: true });
const sqlOf = (schema: any, name: string) =>
  adapter.generatePolicies(schema).find((f) => f.path === `${name}_rls.sql`)!.content;
const codes = (schema: unknown) => checkSchema(schema).map((i) => `${i.severity}:${i.code}:${i.path}`);

describe('policies.all', () => {
  it('expands to the four operations with explicit keys overriding', () => {
    const owner = policy.isOwner('user_id');
    expect(expandAllPolicy({ all: owner, delete: policy.none() })).toEqual({
      select: owner, insert: owner, update: owner, delete: policy.none(),
    });
    expect(expandAllPolicy({ select: owner })).toEqual({ select: owner });
    expect(expandAllPolicy({ all: undefined, select: owner })).toEqual({ select: owner });
  });

  it('generates one policy per operation with the right USING / WITH CHECK', () => {
    const schema = defineSchema({
      notes: table({
        columns: { id: 'uuid', user_id: 'uuid', body: 'text' },
        primaryKey: 'id',
        policies: { all: policy.isOwner('user_id'), delete: policy.none() },
      }),
    });
    const sql = sqlOf(schema, 'notes');
    const own = '(SELECT auth.uid()) = user_id';
    expect(sql).not.toMatch(/FOR ALL/);
    expect(sql).toContain(`ON notes FOR SELECT\n  TO authenticated\n  USING (\n    ${own}\n  );`);
    expect(sql).toContain(`ON notes FOR INSERT\n  TO authenticated\n  WITH CHECK (\n    ${own}\n  );`);
    expect(sql).toContain(`ON notes FOR UPDATE\n  TO authenticated\n  USING (\n    ${own}\n  )\n  WITH CHECK (\n    ${own}\n  );`);
    expect(sql).toContain('ON notes FOR DELETE\n  TO authenticated\n  USING (\n    FALSE\n  );');
    expect(sql.match(/CREATE POLICY/g)).toHaveLength(4);
  });

  it('works in Database mode and validates cleanly', () => {
    const schema = defineSchema({ notes: { policies: { all: policy.isOwner('user_id') } } } as any);
    expect(Object.keys((schema as any).notes.policies)).toEqual(['select', 'insert', 'update', 'delete']);
    expect(codes(schema)).toEqual([]);
  });

  it('is accepted by validate (no UNKNOWN_POLICY_OPERATION), also on a hand-built schema', () => {
    const raw = { notes: { columns: { id: 'uuid', user_id: 'uuid' }, primaryKey: 'id', policies: { all: policy.isOwner('user_id') } } };
    expect(codes(raw)).toEqual([]);
  });

  it('keeps the security warnings: PUBLIC_WRITE and USER_ROW_INSERT_OPEN', () => {
    const open = defineSchema({
      secrets: table({ columns: { id: 'uuid', body: 'text' }, primaryKey: 'id', policies: { all: policy.public() } }),
    });
    expect(codes(open)).toEqual([
      'warning:PUBLIC_WRITE:secrets.policies.insert',
      'warning:PUBLIC_WRITE:secrets.policies.update',
      'warning:PUBLIC_WRITE:secrets.policies.delete',
    ]);
    const profiles = defineSchema({
      profiles: table({
        columns: { id: 'uuid', name: 'text' },
        primaryKey: 'id',
        references: { id: 'auth.users.id' },
        policies: { all: policy.isAuthenticated(), update: policy.isOwner('id'), delete: policy.isOwner('id') },
      }),
    });
    expect(codes(profiles)).toEqual(['warning:USER_ROW_INSERT_OPEN:profiles.policies.insert']);
  });

  it('is distinct from the policy.all([...]) combinator', () => {
    const schema = defineSchema({
      docs: table({
        columns: { id: 'uuid', user_id: 'uuid', published: 'boolean' },
        primaryKey: 'id',
        policies: { all: policy.all([policy.isOwner('user_id'), policy.matchesField('user_id', 'auth.uid()')]) },
      }),
    });
    const sql = sqlOf(schema, 'docs');
    for (const op of ['select', 'insert', 'update', 'delete']) expect(sql).toContain(`"accessnexus_docs_${op}"`);
    expect(sql).toContain('AND');
  });
});

describe('definePermissions all', () => {
  const perms = definePermissions({
    roles: ['admin'],
    resources: {
      notes: { ownerColumn: 'user_id', all: 'own', read: '*' },
      logs: { all: 'none' },
    },
  });

  it('fills every action without its own level, keeping the write pins', () => {
    const notes = perms.policiesFor('notes');
    expect(notes.select).toEqual(perms.can('notes', 'read'));
    expect(notes.select?.kind).toBe('authenticated');
    expect(notes.update).toEqual(perms.can('notes', 'update'));
    expect(notes.delete?.kind).toBe('owner');
    expect(notes.insert?.kind).toBeDefined();
    expect(Object.keys(perms.policiesFor('logs')).sort()).toEqual(['delete', 'insert', 'select', 'update']);
    expect((perms.resources as any).notes.all).toBeUndefined();
  });
});
