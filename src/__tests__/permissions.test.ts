import { describe, it, expect, expectTypeOf } from 'vitest';
import { definePermissions } from '../core/permissions/builders.js';
import { SupabaseAdapter } from '../adapters/supabase/adapter.js';
import { defineSchema, table } from '../core/schema/builders.js';

describe('definePermissions', () => {
  const permissions = definePermissions({
    roles: ['admin', 'manager', 'barber', 'client'],
    resources: {
      shops: {
        ownerColumn: 'owner_id',
        read: 'public',
        create: ['admin'],
        update: ['admin', 'manager'],
        delete: ['admin'],
      },
      appointments: {
        ownerColumn: 'client_id',
        read: 'own',
        create: ['client', 'barber'],
        update: 'own',
        delete: ['admin'],
      },
      profiles: {
        ownerColumn: 'id',
        read: '*',
        create: '*',
        update: 'own',
        delete: 'none',
      },
    },
  });

  describe('can()', () => {
    it('should resolve "public" to a public rule', () => {
      const rule = permissions.can('shops', 'read');
      expect(rule.kind).toBe('public');
    });

    it('should resolve "*" to an authenticated rule', () => {
      const rule = permissions.can('profiles', 'read');
      expect(rule.kind).toBe('authenticated');
    });

    it('should resolve "none" to a none rule', () => {
      const rule = permissions.can('profiles', 'delete');
      expect(rule.kind).toBe('none');
    });

    it('should resolve "own" to an owner rule with the ownerColumn', () => {
      const rule = permissions.can('appointments', 'read');
      expect(rule.kind).toBe('owner');
      expect((rule as any).column).toBe('client_id');
    });

    it('should resolve single-role array to a role rule', () => {
      const rule = permissions.can('shops', 'delete');
      expect(rule.kind).toBe('role');
      expect((rule as any).role).toBe('admin');
    });

    it('pins ownerColumn = auth.uid() on create (no rows attributed to someone else)', () => {
      const rule = permissions.can('shops', 'create') as any;
      expect(rule.kind).toBe('with_check');
      expect(rule.using).toEqual({ kind: 'role', role: 'admin' });
      expect(rule.check).toEqual({ kind: 'owner', column: 'owner_id' });
    });

    it('pinOwnerOnCreate: false keeps create as the plain level', () => {
      const relaxed = definePermissions({
        roles: ['manager'],
        resources: { tasks: { ownerColumn: 'assignee_id', create: ['manager'], pinOwnerOnCreate: false } },
      });
      expect(relaxed.can('tasks', 'create')).toEqual({ kind: 'role', role: 'manager' });
    });

    it('should resolve multi-role array to an any(role) rule', () => {
      const rule = permissions.can('shops', 'update');
      expect(rule.kind).toBe('any');
      const anyRule = rule as any;
      expect(anyRule.rules).toHaveLength(2);
      expect(anyRule.rules[0].kind).toBe('role');
      expect(anyRule.rules[0].role).toBe('admin');
      expect(anyRule.rules[1].kind).toBe('role');
      expect(anyRule.rules[1].role).toBe('manager');
    });

    it('should throw for unknown resource', () => {
      expect(() => permissions.can('unknown', 'read')).toThrow('Resource "unknown" not found');
    });

    it('should throw for undefined action', () => {
      const partial = definePermissions({
        roles: ['admin'],
        resources: {
          items: { read: '*' },
        },
      });
      expect(() => partial.can('items', 'create')).toThrow('No permission defined for items.create');
    });
  });

  describe('policiesFor()', () => {
    it('should return TablePolicies with correct operation mapping', () => {
      const policies = permissions.policiesFor('shops');
      expect(policies.select).toBeDefined();
      expect(policies.insert).toBeDefined();
      expect(policies.update).toBeDefined();
      expect(policies.delete).toBeDefined();
    });

    it('should map read→select, create→insert', () => {
      const policies = permissions.policiesFor('shops');
      expect(policies.select!.kind).toBe('public');
      expect(policies.insert!.kind).toBe('with_check');
      expect((policies.insert as any).using.role).toBe('admin');
    });

    it('should only include defined actions', () => {
      const partial = definePermissions({
        roles: ['admin'],
        resources: {
          items: { read: '*', create: ['admin'] },
        },
      });
      const policies = partial.policiesFor('items');
      expect(policies.select).toBeDefined();
      expect(policies.insert).toBeDefined();
      expect(policies.update).toBeUndefined();
      expect(policies.delete).toBeUndefined();
    });

    it('should throw for unknown resource', () => {
      expect(() => permissions.policiesFor('nope')).toThrow('Resource "nope" not found');
    });
  });

  describe('validation', () => {
    it('should throw for unknown roles in resource definitions', () => {
      expect(() =>
        definePermissions({
          roles: ['admin'],
          resources: {
            shops: { read: ['admin', 'superuser'] },
          },
        })
      ).toThrow('Unknown role "superuser"');
    });

    it('should accept empty role arrays as "none"', () => {
      const p = definePermissions({
        roles: ['admin'],
        resources: {
          items: { read: [] },
        },
      });
      const rule = p.can('items', 'read');
      expect(rule.kind).toBe('none');
    });

    it('should throw when "own" is used without ownerColumn', () => {
      const p = definePermissions({
        roles: ['admin'],
        resources: {
          items: { read: 'own' },
        },
      });
      expect(() => p.can('items', 'read')).toThrow('ownerColumn');
    });
  });

  describe('integration with SupabaseAdapter', () => {
    const adapter = new SupabaseAdapter({ timestamps: false });

    it('should generate valid RLS SQL from permission policies', () => {
      const schema = defineSchema({
        shops: table({
          columns: {
            id: 'uuid',
            name: 'text',
            owner_id: 'uuid',
          },
          primaryKey: 'id',
          policies: permissions.policiesFor('shops'),
        }),
      });

      const outputs = adapter.generatePolicies(schema);
      expect(outputs).toHaveLength(1);

      const sql = outputs[0].content;
      expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
      // read = public → TRUE
      expect(sql).toContain('TRUE');
      // create = [admin] → hasRole('admin')
      expect(sql).toContain("'admin'");
      // update = [admin, manager] → any(hasRole('admin'), hasRole('manager'))
      expect(sql).toContain('OR');
    });

    it('should generate owner-based SQL for "own" permission', () => {
      const schema = defineSchema({
        appointments: table({
          columns: {
            id: 'uuid',
            client_id: 'uuid',
            date: 'timestamptz',
          },
          primaryKey: 'id',
          policies: permissions.policiesFor('appointments'),
        }),
      });

      const outputs = adapter.generatePolicies(schema);
      const sql = outputs[0].content;
      // read = own → auth.uid() = client_id
      expect(sql).toContain('(SELECT auth.uid()) = client_id');
    });
  });

  describe('roles property', () => {
    it('should expose roles as frozen array', () => {
      expect(permissions.roles).toEqual(['admin', 'manager', 'barber', 'client']);
      expect(Object.isFrozen(permissions.roles)).toBe(true);
    });
  });

  describe('multi-tenant scoping', () => {
    const tenantPerms = definePermissions({
      roles: ['admin', 'manager', 'barber', 'client'],
      tenant: {
        table: 'shop_members',
        userColumn: 'user_id',
        tenantColumn: 'shop_id',
        roleColumn: 'role',
      },
      resources: {
        shops: {
          ownerColumn: 'owner_id',
          tenantColumn: 'id',
          read: 'public',
          create: ['admin'],
          update: { scope: 'tenant', roles: ['manager'] },
          delete: ['admin'],
        },
        appointments: {
          ownerColumn: 'client_id',
          tenantColumn: 'shop_id',
          read: { any: ['own', { scope: 'tenant' }] },
          create: '*',
          update: 'own',
          delete: ['admin'],
        },
        services: {
          tenantColumn: 'shop_id',
          read: 'public',
          create: { scope: 'tenant', roles: ['manager', 'admin'] },
          update: { scope: 'tenant', roles: ['manager'] },
          delete: { scope: 'tenant', roles: ['admin'] },
        },
      },
    });

    describe('can() with tenant scope', () => {
      it('should resolve { scope: "tenant" } to a belongs_to rule', () => {
        const rule = tenantPerms.can('appointments', 'read');
        expect(rule.kind).toBe('any');
        const anyRule = rule as any;
        expect(anyRule.rules).toHaveLength(2);
        expect(anyRule.rules[0].kind).toBe('owner');
        expect(anyRule.rules[0].column).toBe('client_id');
        expect(anyRule.rules[1].kind).toBe('belongs_to');
        expect(anyRule.rules[1].column).toBe('shop_id');
        expect(anyRule.rules[1].through.table).toBe('shop_members');
        expect(anyRule.rules[1].through.foreignKey).toBe('shop_id');
        expect(anyRule.rules[1].through.localKey).toBe('user_id');
      });

      it('should resolve { scope: "tenant", roles: [...] } to belongs_to with where clause', () => {
        const rule = tenantPerms.can('shops', 'update');
        expect(rule.kind).toBe('belongs_to');
        const btRule = rule as any;
        expect(btRule.column).toBe('id');
        expect(btRule.through.table).toBe('shop_members');
        expect(btRule.through.where).toEqual({ role: ['manager'] });
      });

      it('should resolve tenant scope with multiple roles', () => {
        const rule = tenantPerms.can('services', 'create');
        expect(rule.kind).toBe('belongs_to');
        const btRule = rule as any;
        expect(btRule.through.where).toEqual({ role: ['manager', 'admin'] });
      });

      it('should resolve tenant scope without roles (no where clause)', () => {
        const rule = tenantPerms.can('appointments', 'read') as any;
        const tenantRule = rule.rules[1];
        expect(tenantRule.kind).toBe('belongs_to');
        expect(tenantRule.through.where).toBeUndefined();
      });
    });

    describe('policiesFor() with tenant scope', () => {
      it('should generate correct policies for tenant-scoped resource', () => {
        const policies = tenantPerms.policiesFor('services');
        expect(policies.select!.kind).toBe('public');
        expect(policies.insert!.kind).toBe('belongs_to');
        expect(policies.update!.kind).toBe('belongs_to');
        expect(policies.delete!.kind).toBe('belongs_to');
      });
    });

    describe('write pins', () => {
      const pinned = definePermissions({
        roles: ['manager'],
        tenant: { table: 'org_members', userColumn: 'user_id', tenantColumn: 'org_id', roleColumn: 'role' },
        resources: {
          tasks: {
            ownerColumn: 'assignee_id',
            tenantColumn: 'org_id',
            pinOwnerOnCreate: false,
            create: { scope: 'tenant' },
            update: { any: ['own', { scope: 'tenant', roles: ['manager'] }] },
          },
          comments: { ownerColumn: 'author_id', tenantColumn: 'org_id', create: 'own', update: 'own' },
          orgs: { ownerColumn: 'owner_id', tenantColumn: 'id', create: '*', update: { scope: 'tenant', roles: ['manager'] } },
          bookings: { ownerColumn: 'client_id', tenantColumn: 'org_id', pinTenant: false, create: '*', update: 'own' },
        },
      });
      const member = { kind: 'belongs_to', column: 'org_id', through: { table: 'org_members', foreignKey: 'org_id', localKey: 'user_id' } };

      it('update: an owner cannot move the row into another tenant', () => {
        const rule = pinned.can('tasks', 'update') as any;
        expect(rule.kind).toBe('with_check');
        expect(rule.using.kind).toBe('any');
        expect(rule.check).toEqual(member);
        expect((pinned.can('comments', 'update') as any).check).toEqual(member);
      });

      it('create: non-tenant levels get tenant membership and the owner pin', () => {
        const rule = pinned.can('comments', 'create') as any;
        expect(rule.kind).toBe('with_check');
        expect(rule.check).toEqual(member); // 'own' already pins the owner
        // tenant-scoped create needs no extra tenant pin; owner pin disabled
        expect(pinned.can('tasks', 'create').kind).toBe('belongs_to');
      });

      it('create on the tenant table itself (tenantColumn id) only pins the owner', () => {
        const rule = pinned.can('orgs', 'create') as any;
        expect(rule.check).toEqual({ kind: 'owner', column: 'owner_id' });
        expect(pinned.can('orgs', 'update').kind).toBe('belongs_to');
      });

      it('pinTenant: false leaves writes by non-members alone', () => {
        expect(pinned.can('bookings', 'update')).toEqual({ kind: 'owner', column: 'client_id' });
        expect((pinned.can('bookings', 'create') as any).check).toEqual({ kind: 'owner', column: 'client_id' });
      });

      it('compiles to WITH CHECK (using AND membership)', () => {
        const schema = defineSchema({
          comments: table({
            columns: { id: 'uuid', org_id: 'uuid', author_id: 'uuid' },
            primaryKey: 'id',
            policies: pinned.policiesFor('comments'),
          }),
        });
        const sql = new SupabaseAdapter({ timestamps: false }).generatePolicies(schema)[0].content;
        const update = sql.split('FOR UPDATE')[1];
        expect(update).toContain('USING (\n    (SELECT auth.uid()) = author_id\n  )');
        expect(update).toContain('AND ((SELECT accessnexus_comments_belongs_to_1_fn(org_id)))');
      });
    });

    describe('tenant validation', () => {
      it('should throw when tenant scope used without tenant config', () => {
        expect(() =>
          definePermissions({
            roles: ['admin'],
            resources: {
              items: { tenantColumn: 'org_id', read: { scope: 'tenant' } },
            },
          })
        ).toThrow('no tenant config was provided');
      });

      it('should throw when tenant scope used without tenantColumn on resource', () => {
        const p = definePermissions({
          roles: ['admin'],
          tenant: {
            table: 'members',
            userColumn: 'user_id',
            tenantColumn: 'org_id',
          },
          resources: {
            items: { read: { scope: 'tenant' } },
          },
        });
        expect(() => p.can('items', 'read')).toThrow('tenantColumn');
      });

      it('should throw when tenant-scoped roles used without roleColumn', () => {
        const p = definePermissions({
          roles: ['admin'],
          tenant: {
            table: 'members',
            userColumn: 'user_id',
            tenantColumn: 'org_id',
          },
          resources: {
            items: { tenantColumn: 'org_id', read: { scope: 'tenant', roles: ['admin'] } },
          },
        });
        expect(() => p.can('items', 'read')).toThrow('roleColumn');
      });

      it('should validate roles inside tenant scope against declared roles', () => {
        expect(() =>
          definePermissions({
            roles: ['admin'],
            tenant: {
              table: 'members',
              userColumn: 'user_id',
              tenantColumn: 'org_id',
              roleColumn: 'role',
            },
            resources: {
              items: { tenantColumn: 'org_id', read: { scope: 'tenant', roles: ['superuser'] } },
            },
          })
        ).toThrow('Unknown role "superuser"');
      });

      it('should validate roles inside { any: [...] } combinations', () => {
        expect(() =>
          definePermissions({
            roles: ['admin'],
            resources: {
              items: { ownerColumn: 'user_id', read: { any: ['own', ['ghost']] } },
            },
          })
        ).toThrow('Unknown role "ghost"');
      });
    });

    describe('integration with SupabaseAdapter (tenant)', () => {
      const adapter = new SupabaseAdapter({ timestamps: false });

      it('should generate belongs_to SQL with where clause for tenant-scoped roles', () => {
        const schema = defineSchema({
          shops: table({
            columns: {
              id: 'uuid',
              name: 'text',
              owner_id: 'uuid',
            },
            primaryKey: 'id',
            policies: tenantPerms.policiesFor('shops'),
          }),
        });

        const outputs = adapter.generatePolicies(schema);
        const sql = outputs[0].content;
        // update = { scope: 'tenant', roles: ['manager'] } → belongs_to with WHERE role IN ('manager')
        expect(sql).toContain('shop_members');
        expect(sql).toContain("'manager'");
      });

      it('should generate combined owner + tenant SQL for { any: ["own", { scope: "tenant" }] }', () => {
        const schema = defineSchema({
          appointments: table({
            columns: {
              id: 'uuid',
              client_id: 'uuid',
              shop_id: 'uuid',
              date: 'timestamptz',
            },
            primaryKey: 'id',
            policies: tenantPerms.policiesFor('appointments'),
          }),
        });

        const outputs = adapter.generatePolicies(schema);
        const sql = outputs[0].content;
        // read = { any: ['own', { scope: 'tenant' }] } → owner OR belongs_to
        expect(sql).toContain('(SELECT auth.uid()) = client_id');
        expect(sql).toContain('shop_members');
        expect(sql).toContain('OR');
      });
    });
  });
});

describe('definePermissions typing', () => {
  it('accepts only declared resource names in policiesFor / can', () => {
    const p = definePermissions({ roles: ['admin'], resources: { tasks: { read: '*' }, projects: { read: 'none' } } });
    expectTypeOf(p.policiesFor).parameter(0).toEqualTypeOf<'tasks' | 'projects'>();
    expectTypeOf(p.can).parameter(0).toEqualTypeOf<'tasks' | 'projects'>();
    // A typo is still caught at runtime for untyped callers.
    expect(() => p.policiesFor('taks' as any)).toThrow(/Resource "taks" not found/);
  });
});
