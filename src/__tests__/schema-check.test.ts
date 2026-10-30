// Static schema checks (`accessnexus validate`): every user mistake must come back
// as an issue with a stable code, a dotted path and a hint — never as a Postgres
// error at push time.

import { describe, expect, it } from 'vitest';
import schema from '../../examples/fullstack-saas.schema.js';
import { checkSchema, summarizeSchema } from '../cli/schema-check.js';
import { defineSchema, policy, rpc, table, trigger } from '../index.js';

function codes(input: unknown): string[] {
  return checkSchema(input).map((issue) => `${issue.severity}:${issue.code}:${issue.path}`);
}

describe('checkSchema', () => {
  it('reports nothing for the full example schema', () => {
    expect(checkSchema(schema)).toEqual([]);
  });

  it('rejects a non-object default export', () => {
    expect(codes(undefined)).toEqual(['error:SCHEMA_NOT_AN_OBJECT:(default export)']);
    expect(codes([])).toEqual(['error:SCHEMA_NOT_AN_OBJECT:(default export)']);
  });

  it('warns on an empty schema', () => {
    expect(codes({})).toEqual(['warning:SCHEMA_EMPTY:(schema)']);
  });

  it('flags unknown columns in policies with the available columns in the hint', () => {
    const issues = checkSchema(defineSchema({
      posts: table({
        columns: { id: 'uuid', author_id: 'uuid', org_id: 'uuid' },
        primaryKey: 'id',
        policies: {
          select: policy.isOwner('owner_id'),
          insert: policy.matchesField('writer_id', 'auth.uid()'),
          update: policy.withCheck(policy.isOwner('author_id'), policy.isOwner('creator_id')),
          delete: policy.any([policy.belongsTo('team_id', {
            table: 'posts', foreignKey: 'org_id', localKey: 'author_id',
          })]),
        },
      }),
    }));

    expect(issues.map((i) => `${i.code}:${i.path}`)).toEqual([
      'UNKNOWN_COLUMN:posts.policies.select',
      'UNKNOWN_COLUMN:posts.policies.insert',
      'UNKNOWN_COLUMN:posts.policies.update.check',
      'UNKNOWN_COLUMN:posts.policies.delete.any[0]',
    ]);
    expect(issues[0].message).toContain('"owner_id"');
    expect(issues[0].hint).toContain('id, author_id, org_id');
  });

  it('flags an unknown membership table and its columns', () => {
    const issues = checkSchema(defineSchema({
      members: table({ columns: { id: 'uuid', org_id: 'uuid', user_id: 'uuid' }, primaryKey: 'id', policies: { select: policy.none() } }),
      docs: table({
        columns: { id: 'uuid', org_id: 'uuid' },
        primaryKey: 'id',
        policies: {
          select: policy.belongsTo('org_id', { table: 'memberz', foreignKey: 'org_id', localKey: 'user_id' }),
          insert: policy.belongsTo('org_id', {
            table: 'members', foreignKey: 'org_id', localKey: 'uid', where: { role: ['admin'] },
          }),
        },
      }),
    }));

    expect(issues.map((i) => `${i.code}:${i.path}`)).toEqual([
      'UNKNOWN_TABLE:docs.policies.select',
      'UNKNOWN_COLUMN:docs.policies.insert',
      'UNKNOWN_COLUMN:docs.policies.insert',
    ]);
    expect(issues[0].hint).toContain('members, docs');
  });

  it('requires a profiles table for belongsTo without `through`', () => {
    const issues = checkSchema({
      docs: { columns: { id: 'uuid', org_id: 'uuid' }, primaryKey: 'id', policies: { select: policy.belongsTo('org_id') } },
    });
    expect(issues.map((i) => i.code)).toEqual(['UNKNOWN_TABLE']);
    expect(issues[0].hint).toContain("table: 'org_members'");
  });

  it('rejects isOwner on a non-uuid column (uuid = text has no operator in Postgres)', () => {
    const issues = checkSchema({
      notes: { columns: { id: 'uuid', owner: 'text' }, primaryKey: 'id', policies: { select: policy.isOwner('owner') } },
    });
    expect(issues.map((i) => i.code)).toEqual(['OWNER_COLUMN_NOT_UUID']);
  });

  it('rejects policies written as strings or with CRUD verbs as keys', () => {
    const issues = checkSchema({
      notes: {
        columns: { id: 'uuid' },
        primaryKey: 'id',
        policies: { select: 'public', read: policy.public() },
      },
    });
    expect(issues.map((i) => `${i.code}:${i.path}`)).toEqual([
      'INVALID_POLICY_RULE:notes.policies.select',
      'UNKNOWN_POLICY_OPERATION:notes.policies.read',
    ]);
    expect(issues[1].hint).toContain('"select"');
  });

  it('rejects empty any()/all() combinators', () => {
    const issues = checkSchema({
      notes: { columns: { id: 'uuid' }, primaryKey: 'id', policies: { select: policy.any([]), update: policy.all([]) } },
    });
    expect(issues.map((i) => i.code)).toEqual(['EMPTY_COMBINATOR', 'EMPTY_COMBINATOR']);
  });

  it('suggests the AccessNexus spelling for common wrong column types', () => {
    const issues = checkSchema({
      users: { columns: { id: 'uuid', name: 'string', age: 'integer?', meta: { type: 'object' } }, primaryKey: 'id', policies: { select: policy.public() } },
    });
    expect(issues.map((i) => `${i.code}:${i.path}:${i.hint}`)).toEqual([
      "UNKNOWN_COLUMN_TYPE:users.columns.name:Use 'text'.",
      "UNKNOWN_COLUMN_TYPE:users.columns.age:Use 'int?'.",
      "UNKNOWN_COLUMN_TYPE:users.columns.meta:Use 'jsonb'.",
    ]);
  });

  it('accepts every documented column type, enums and nullable variants', () => {
    const types = ['uuid', 'text', 'varchar', 'int', 'smallint', 'bigint', 'serial', 'float', 'decimal',
      'boolean', 'json', 'jsonb', 'date', 'timestamp', 'timestamptz', 'time', 'text[]', 'int[]', 'uuid[]',
      "enum('a','b')", 'text?', "enum('x')?"];
    const columns = Object.fromEntries(types.map((t, i) => [`c${i}`, t]));
    expect(checkSchema({ t: { columns: { id: 'uuid', ...columns }, primaryKey: 'id', policies: { select: policy.public() } } })).toEqual([]);
  });

  it('checks references, primary keys, soft delete, triggers and indexes', () => {
    const issues = checkSchema({
      posts: {
        columns: { id: 'uuid', author_id: 'uuid', deleted: 'timestamptz?' },
        primaryKey: 'pk',
        references: { author_id: 'profiles.uid', id: 'auth.users.id', ghost: 'posts.id' },
        softDelete: 'deleted_at',
        triggers: [
          trigger.updatedAt('updated_at'),
          trigger.auditLog({ table: 'audit', columns: ['title'] }),
          trigger.custom({ name: 'Bad Name', events: ['on_save' as any], functionBody: '' }),
        ],
        indexes: [{ columns: ['slug'] }],
        policies: { select: policy.public() },
      },
      profiles: { columns: { id: 'uuid' }, primaryKey: 'id', policies: { select: policy.public() } },
    });
    expect(issues.map((i) => `${i.code}:${i.path}`)).toEqual([
      'UNKNOWN_COLUMN:posts.primaryKey',
      'UNKNOWN_COLUMN:posts.references.author_id',
      'UNKNOWN_COLUMN:posts.references.ghost',
      'UNKNOWN_COLUMN:posts.softDelete',
      'UNKNOWN_COLUMN:posts.triggers[0]',
      'UNKNOWN_TABLE:posts.triggers[1]',
      'UNKNOWN_COLUMN:posts.triggers[1]',
      'INVALID_IDENTIFIER:posts.triggers[2]',
      'INVALID_TRIGGER:posts.triggers[2]',
      'INVALID_TRIGGER:posts.triggers[2]',
      'UNKNOWN_COLUMN:posts.indexes[0]',
    ]);
  });

  it('checks the audit table against the columns the audit trigger inserts', () => {
    const issues = checkSchema({
      orders: {
        columns: { id: 'uuid' },
        primaryKey: 'id',
        triggers: [trigger.auditLog({ table: 'audit' })],
        policies: { select: policy.public() },
      },
      audit: {
        columns: { id: 'bigint', table_name: 'text', action: 'text', created_at: 'timestamptz' },
        primaryKey: 'id',
        policies: { select: policy.none(), insert: policy.none() },
      },
    });
    expect(issues.map((i) => `${i.severity}:${i.code}`)).toEqual(['error:AUDIT_TABLE_MISMATCH']);
    expect(issues[0].message).toContain('operation, old_data, new_data, changed_at');
    expect(issues[0].message).toContain('action, created_at');
  });

  it('accepts an audit table that matches the trigger and blocks API inserts', () => {
    expect(checkSchema({
      orders: {
        columns: { id: 'uuid' },
        primaryKey: 'id',
        triggers: [trigger.auditLog({ table: 'audit' })],
        policies: { select: policy.public() },
      },
      audit: {
        columns: {
          id: 'bigint', table_name: 'text', operation: 'text', old_data: 'jsonb?', new_data: 'jsonb?',
          changed_at: { type: 'timestamptz', default: 'now()' }, note: 'text?',
        },
        primaryKey: 'id',
        policies: { select: policy.none(), insert: policy.none() },
      },
    })).toEqual([]);
  });

  it('warns when API users can insert into the audit table (forged entries)', () => {
    expect(codes({
      orders: {
        columns: { id: 'uuid' },
        primaryKey: 'id',
        triggers: [trigger.auditLog({ table: 'audit' })],
        policies: { select: policy.public() },
      },
      audit: {
        columns: {
          id: 'bigint', table_name: 'text', operation: 'text', old_data: 'jsonb?', new_data: 'jsonb?',
          changed_at: { type: 'timestamptz', default: 'now()' },
        },
        primaryKey: 'id',
        policies: { select: policy.none(), insert: policy.isAuthenticated() },
      },
    })).toEqual(['warning:AUDIT_INSERT_OPEN:audit.policies.insert']);
  });

  it('rejects reserved SQL keywords as table or column names', () => {
    expect(codes({
      order: { columns: { id: 'uuid', user: 'uuid', limit: 'int' }, primaryKey: 'id', policies: { select: policy.public() } },
    })).toEqual([
      'error:RESERVED_IDENTIFIER:order',
      'error:RESERVED_IDENTIFIER:order.columns.user',
      'error:RESERVED_IDENTIFIER:order.columns.limit',
    ]);
  });

  it('warns when a global app role is mixed with tenant membership checks', () => {
    const member = policy.belongsTo('org_id', { table: 'org_members', foreignKey: 'org_id', localKey: 'user_id' });
    expect(codes({
      org_members: { columns: { id: 'uuid', org_id: 'uuid', user_id: 'uuid' }, primaryKey: 'id', policies: { select: policy.isOwner('user_id') } },
      projects: {
        columns: { id: 'uuid', org_id: 'uuid' },
        primaryKey: 'id',
        policies: { select: member, delete: policy.hasRole('admin') },
      },
    })).toEqual(['warning:GLOBAL_ROLE_IN_TENANT_TABLE:projects.policies.delete']);
  });

  it('warns when a table has no policies (deny-all), RLS turned off, or no primary key', () => {
    expect(codes({ logs: { columns: { msg: 'text' } } })).toEqual([
      'warning:NO_PRIMARY_KEY:logs.primaryKey',
      'warning:NO_POLICIES:logs.policies',
    ]);
    const [locked] = checkSchema({ logs: { columns: { id: 'uuid' }, primaryKey: 'id' } });
    expect(locked.message).toContain('service role only');

    expect(codes({ logs: { columns: { id: 'uuid' }, primaryKey: 'id', enableRLS: false } })).toEqual([
      'warning:RLS_DISABLED:logs.enableRLS',
    ]);
    expect(codes({
      logs: { columns: { id: 'uuid' }, primaryKey: 'id', enableRLS: false, policies: { select: policy.public() } },
    })).toEqual(['error:RLS_DISABLED_WITH_POLICIES:logs.enableRLS']);
  });

  it('warns when a tenant row points at another tenant-scoped row without a same-tenant guard', () => {
    const member = policy.belongsTo('org_id', { table: 'org_members', foreignKey: 'org_id', localKey: 'user_id' });
    const tenantPolicies = { select: member, insert: member, update: member, delete: member };
    const build = (taskTriggers: unknown[]) => ({
      orgs: { columns: { id: 'uuid' }, primaryKey: 'id', policies: { select: policy.belongsTo('id', { table: 'org_members', foreignKey: 'org_id', localKey: 'user_id' }) } },
      org_members: { columns: { id: 'uuid', org_id: 'uuid', user_id: 'uuid' }, primaryKey: 'id', references: { org_id: 'orgs.id' }, policies: { select: policy.isOwner('user_id') } },
      projects: { columns: { id: 'uuid', org_id: 'uuid' }, primaryKey: 'id', references: { org_id: 'orgs.id' }, policies: tenantPolicies },
      tasks: {
        columns: { id: 'uuid', org_id: 'uuid', project_id: { type: 'uuid', references: 'projects.id' } },
        primaryKey: 'id',
        references: { org_id: 'orgs.id' },
        policies: tenantPolicies,
        triggers: taskTriggers,
      },
    });

    expect(codes(build([]))).toEqual(['warning:TENANT_PARENT_UNCHECKED:tasks.references.project_id']);
    const [issue] = checkSchema(build([]));
    expect(issue.hint).toContain('p.org_id = NEW.org_id');

    expect(codes(build([trigger.custom({
      name: 'same_org_project',
      events: ['before_insert', 'before_update'],
      functionBody: "IF NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.id = NEW.project_id AND p.org_id = NEW.org_id) THEN RAISE EXCEPTION 'x'; END IF; RETURN NEW;",
    })]))).toEqual([]);
  });

  describe('belongsTo without through (profiles lookup)', () => {
    const docs = {
      columns: { id: 'uuid', org_id: 'uuid' },
      primaryKey: 'id',
      policies: { select: policy.belongsTo('org_id'), delete: policy.belongsTo('org_id') },
    };
    const profiles = (extra: Record<string, unknown>) => ({
      columns: { id: 'uuid', org_id: 'uuid', name: 'text' },
      primaryKey: 'id',
      references: { id: 'auth.users.id' },
      ...extra,
    });

    it('rejects it when users can write profiles.<column> (join any tenant)', () => {
      const result = checkSchema({
        profiles: profiles({ policies: { select: policy.isOwner('id'), update: policy.isOwner('id') } }),
        docs,
      });
      expect(result.filter((i) => i.code === 'BELONGS_TO_PROFILE_WRITABLE')).toHaveLength(1); // reported once
      const [issue] = result.filter((i) => i.code === 'BELONGS_TO_PROFILE_WRITABLE');
      expect(issue).toMatchObject({ severity: 'error', path: 'docs.policies.select' });
      expect(issue.hint).toContain('lockColumns');

      // An open insert is just as bad (lockColumns only guards UPDATE).
      expect(codes({
        profiles: profiles({
          policies: { select: policy.isOwner('id'), insert: policy.isOwner('id') },
          triggers: [trigger.lockColumns({ columns: ['org_id'] })],
        }),
        docs,
      })).toContain('error:BELONGS_TO_PROFILE_WRITABLE:docs.policies.select');

      expect(codes({ profiles: profiles({ enableRLS: false }), docs }))
        .toContain('error:BELONGS_TO_PROFILE_WRITABLE:docs.policies.select');
    });

    it('accepts it when the column is server-written only', () => {
      for (const locked of [
        profiles({
          policies: { select: policy.isOwner('id'), insert: policy.none(), update: policy.isOwner('id') },
          triggers: [trigger.lockColumns({ columns: ['org_id'] })],
        }),
        profiles({
          policies: { select: policy.isOwner('id'), update: policy.isOwner('id') },
          triggers: [trigger.lockColumns({ except: ['name'] })],
        }),
        profiles({ policies: { select: policy.isOwner('id') } }),
        profiles({}), // no policies: deny-all
      ]) {
        expect(codes({ profiles: locked, docs }).filter((c) => c.includes('BELONGS_TO_PROFILE_WRITABLE'))).toEqual([]);
      }
    });
  });

  it('warns on a bare auth.uid() inside policy.custom, but not on the wrapped form', () => {
    const bare = checkSchema({ t: { columns: { id: 'uuid', u: 'uuid' }, primaryKey: 'id', policies: { select: policy.custom('u = auth.uid()') } } });
    expect(bare.map((i) => i.code)).toEqual(['UNWRAPPED_AUTH_CALL']);
    const wrapped = checkSchema({ t: { columns: { id: 'uuid', u: 'uuid' }, primaryKey: 'id', policies: { select: policy.custom('u = (SELECT auth.uid())') } } });
    expect(wrapped).toEqual([]);
  });

  it('rejects an rpc placed among tables and bad rpc argument types', () => {
    expect(codes({ do_it: rpc() })).toEqual(['error:RPC_IN_TABLES:do_it']);
    const withRpcs = defineSchema(
      { t: table({ columns: { id: 'uuid' }, primaryKey: 'id', policies: { select: policy.public() } }) },
      { rpcs: { get_x: rpc({ args: { n: 'number' as any }, returns: 'int', body: 'RETURN 1;' }) } },
    );
    expect(codes(withRpcs)).toEqual(['error:UNKNOWN_COLUMN_TYPE:rpcs.get_x.args.n']);
  });

  it('validates rpc returns: scalar, table and setof', () => {
    const t = () => ({ t: table({ columns: { id: 'uuid' }, primaryKey: 'id', policies: { select: policy.public() } }) });
    const ok = defineSchema(t(), { rpcs: {
      a: rpc({ returns: { table: { id: 'uuid', n: 'int?' } } }),
      b: rpc({ returns: { setof: 't' } }),
      c: rpc({ returns: { setof: 'uuid' } }),
      d: rpc({ returns: 'void' }),
    } });
    expect(codes(ok)).toEqual([]);
    const bad = defineSchema(t(), { rpcs: {
      a: rpc({ returns: { table: {} } }),
      b: rpc({ returns: { setof: 'nope' } }),
      c: rpc({ returns: { table: { BadName: 'uuid', x: 'number' as any } } }),
      d: rpc({ returns: 'number' as any }),
      e: rpc({ returns: { rows: 't' } as any }),
    } });
    expect(codes(bad)).toEqual([
      'error:INVALID_RPC_RETURNS:rpcs.a.returns',
      'error:INVALID_RPC_RETURNS:rpcs.b.returns',
      'error:INVALID_IDENTIFIER:rpcs.c.returns.table.BadName',
      'error:UNKNOWN_COLUMN_TYPE:rpcs.c.returns.table.x',
      'error:INVALID_RPC_RETURNS:rpcs.d.returns',
      'error:INVALID_RPC_RETURNS:rpcs.e.returns',
    ]);
  });

  it('flags a manual-mode table without columns', () => {
    expect(codes({
      a: { columns: { id: 'uuid' }, primaryKey: 'id', policies: { select: policy.public() } },
      b: { policies: { select: policy.public() } },
    })).toEqual(['error:MISSING_COLUMNS:b.columns']);
  });

  it('skips column checks in Database mode (columns come from the Database type)', () => {
    const issues = checkSchema({
      profiles: { columns: {}, policies: { select: policy.isOwner('id'), update: policy.matchesField('id', 'auth.uid()') } },
    });
    expect(issues).toEqual([]);
  });
});

describe('checkSchema: triggers', () => {
  it('validates trigger.lockColumns', () => {
    const issues = codes(defineSchema({
      tasks: table({
        columns: { id: 'uuid', status: 'text', owner_id: 'uuid' },
        primaryKey: 'id',
        policies: { select: policy.isOwner('owner_id') },
        triggers: [
          trigger.lockColumns({ columns: ['owner_id'], except: ['status'] }),
          trigger.lockColumns({ name: 'second', columns: ['ghost'] }),
          trigger.lockColumns({ name: 'third', except: ['status'], unless: 'auth.uid() = owner_id' }),
        ],
      }),
    }));
    expect(issues).toEqual([
      'error:INVALID_TRIGGER:tasks.triggers[0]',
      'error:UNKNOWN_COLUMN:tasks.triggers[1]',
      'warning:UNWRAPPED_AUTH_CALL:tasks.triggers[2]',
    ]);
  });

  it('rejects two triggers with the same generated name', () => {
    const issues = codes(defineSchema({
      tasks: table({
        columns: { id: 'uuid', a: 'text', b: 'text' },
        primaryKey: 'id',
        policies: { select: policy.none() },
        triggers: [trigger.lockColumns({ columns: ['a'] }), trigger.lockColumns({ columns: ['b'] })],
      }),
    }));
    expect(issues).toEqual(['error:DUPLICATE_TRIGGER:tasks.triggers[1]']);
  });

  it('rejects an unknown trigger.custom security value', () => {
    const issues = codes(defineSchema({
      tasks: table({
        columns: { id: 'uuid' },
        primaryKey: 'id',
        policies: { select: policy.none() },
        triggers: [trigger.custom({ name: 'x', events: ['after_insert'], functionBody: 'RETURN NEW;', security: 'owner' as any })],
      }),
    }));
    expect(issues).toEqual(['error:INVALID_TRIGGER:tasks.triggers[0]']);
  });
});

describe('checkSchema: column defaults and foreign keys', () => {
  it('rejects a bare-word default (default is raw SQL)', () => {
    const issues = checkSchema(defineSchema({
      tasks: table({
        columns: {
          id: 'uuid',
          status: { type: "enum('todo','doing','done')", default: 'todo' },
          stage: { type: "enum('a','b')", default: "'c'" },
          label: { type: 'text', default: 'untitled' },
          ok_enum: { type: "enum('todo','done')", default: "'todo'" },
          ok_text: { type: 'text', default: "'untitled'" },
          ok_bool: { type: 'boolean', default: 'false' },
          ok_now: { type: 'timestamptz', default: 'now()' },
          ok_kw: { type: 'timestamptz', default: 'CURRENT_TIMESTAMP' },
          ok_num: { type: 'int', default: '0' },
        },
        primaryKey: 'id',
        policies: { select: policy.none() },
      }),
    }));
    expect(issues.map((i) => `${i.code}:${i.path}`)).toEqual([
      'INVALID_DEFAULT:tasks.columns.status.default',
      'INVALID_DEFAULT:tasks.columns.stage.default',
      'INVALID_DEFAULT:tasks.columns.label.default',
    ]);
    expect(issues[0].hint).toContain(`default: "'todo'"`);
  });

  it('rejects ON DELETE CASCADE into a soft-delete table (it would orphan rows)', () => {
    const issues = codes(defineSchema({
      tasks: table({ columns: { id: 'uuid' }, primaryKey: 'id', policies: { select: policy.none() } }),
      comments: table({
        columns: { id: 'uuid', task_id: 'uuid', deleted_at: 'timestamptz?' },
        primaryKey: 'id',
        references: { task_id: 'tasks.id' },
        onDelete: { task_id: 'cascade' },
        softDelete: 'deleted_at',
        policies: { select: policy.none() },
      }),
    }));
    expect(issues).toEqual(['error:CASCADE_INTO_SOFT_DELETE:comments.onDelete.task_id']);
  });

  it('validates onDelete', () => {
    const issues = codes(defineSchema({
      projects: table({ columns: { id: 'uuid' }, primaryKey: 'id', policies: { select: policy.none() } }),
      tasks: table({
        columns: {
          id: 'uuid',
          project_id: 'uuid',
          owner_id: { type: 'uuid', references: 'projects.id', onDelete: 'set null' },
          note: { type: 'text', onDelete: 'cascade' },
          other: { type: 'uuid?', references: 'projects.id', onDelete: 'explode' as any },
        },
        primaryKey: 'id',
        references: { project_id: 'projects.id' },
        onDelete: { project_id: 'cascade', id: 'cascade' },
        policies: { select: policy.none() },
      }),
    }));
    expect(issues).toEqual([
      'error:INVALID_ON_DELETE:tasks.columns.owner_id',
      'error:INVALID_ON_DELETE:tasks.columns.note',
      'error:INVALID_ON_DELETE:tasks.columns.other',
      'error:INVALID_ON_DELETE:tasks.onDelete.id',
    ]);
  });
});

describe('checkSchema: risky access rules', () => {
  it('warns when anon can write (PUBLIC_WRITE), not for public reads or authenticated writes', () => {
    const issues = codes(defineSchema({
      secrets: table({
        columns: { id: 'uuid', body: 'text' },
        primaryKey: 'id',
        policies: {
          select: policy.public(),
          insert: policy.public(),
          update: policy.any([policy.public(), policy.isAuthenticated()]),
          delete: policy.isAuthenticated(),
        },
      }),
    }));
    expect(issues).toEqual([
      'warning:PUBLIC_WRITE:secrets.policies.insert',
      'warning:PUBLIC_WRITE:secrets.policies.update',
    ]);
  });

  it('warns when any signed-in user can insert the row of another auth user', () => {
    const profiles = (insert: any) => codes(defineSchema({
      profiles: table({
        columns: { id: 'uuid', name: 'text' },
        primaryKey: 'id',
        references: { id: 'auth.users.id' },
        policies: { select: policy.isAuthenticated(), insert, update: policy.isOwner('id') },
      }),
    }));
    expect(profiles(policy.isAuthenticated())).toEqual(['warning:USER_ROW_INSERT_OPEN:profiles.policies.insert']);
    expect(profiles(policy.isOwner('id'))).toEqual([]);
  });

  it('warns about a bare auth.uid() in an RPC body', () => {
    const issues = codes(defineSchema({
      notes: table({ columns: { id: 'uuid' }, primaryKey: 'id', policies: { select: policy.none() } }),
    }, {
      rpcs: {
        bad: rpc({ body: 'DELETE FROM notes WHERE id = auth.uid();' }),
        good: rpc({ body: 'DELETE FROM notes WHERE id = (SELECT auth.uid());' }),
      },
    }));
    expect(issues).toEqual(['warning:UNWRAPPED_AUTH_CALL:rpcs.bad.body']);
  });

  it('rejects unknown table options instead of silently dropping them', () => {
    const typo = checkSchema(defineSchema({
      notes: table({ columns: { id: 'uuid' }, primaryKey: 'id', polices: { select: policy.none() } } as any),
    }));
    const unknown = typo.find((i) => i.code === 'UNKNOWN_TABLE_KEY');
    expect(unknown).toMatchObject({ severity: 'error', path: 'notes.polices' });
    expect(unknown?.hint).toContain('Did you mean "policies"?');

    const nested = checkSchema({ tables: { notes: table({ columns: { id: 'uuid' }, primaryKey: 'id' }) } });
    const wrapped = nested.find((i) => i.code === 'UNKNOWN_TABLE_KEY');
    expect(wrapped?.path).toBe('tables.notes');
    expect(wrapped?.hint).toContain('Tables go directly in defineSchema');
  });

  it('rejects belongsTo where values outside the membership enum', () => {
    const issues = checkSchema(defineSchema({
      members: table({
        columns: { id: 'uuid', org_id: 'uuid', user_id: 'uuid', role: "enum('admin','member')" },
        primaryKey: 'id',
        policies: { select: policy.none() },
      }),
      docs: table({
        columns: { id: 'uuid', org_id: 'uuid' },
        primaryKey: 'id',
        policies: {
          select: policy.belongsTo('org_id', {
            table: 'members', foreignKey: 'org_id', localKey: 'user_id', where: { role: ['admin', 'admn'] },
          }),
        },
      }),
    }));
    const invalid = issues.filter((i) => i.code === 'INVALID_ENUM_VALUE');
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toMatchObject({ severity: 'error', path: 'docs.policies.select' });
    expect(invalid[0].hint).toContain('Did you mean "admin"?');
  });
});

describe('summarizeSchema', () => {
  it('summarizes tables, policies, triggers and rpcs', () => {
    const summary = summarizeSchema(schema);
    expect(summary.mode).toBe('manual');
    expect(summary.tables).toHaveLength(8);
    expect(summary.tables[0]).toEqual({
      name: 'profiles',
      columns: 7,
      primaryKey: 'id',
      rls: true,
      policies: ['select', 'insert', 'update', 'delete'],
      triggers: [{ kind: 'updated_at', name: null }],
    });
    // Explicit names let an agent tell two triggers of the same kind apart
    expect(summary.tables.find((t) => t.name === 'tasks')?.triggers).toContainEqual({ kind: 'lock_columns', name: 'assignee_scope' });
    expect(summary.rpcs).toEqual(['get_org_dashboard', 'accept_invitation', 'search_tasks']);
  });
});
