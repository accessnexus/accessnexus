import { describe, it, expect } from 'vitest';
import { trigger } from '../core/triggers/builders.js';
import { SupabaseAdapter } from '../adapters/supabase/adapter.js';
import { defineSchema, table } from '../core/schema/builders.js';
import { policy } from '../core/policy/builders.js';

describe('Trigger Builders', () => {
  describe('trigger.updatedAt()', () => {
    it('should create an updatedAt trigger rule', () => {
      const t = trigger.updatedAt('updated_at');
      expect(t.kind).toBe('updated_at');
      expect(t.column).toBe('updated_at');
    });
  });

  describe('trigger.softDelete()', () => {
    it('should create a soft delete trigger rule', () => {
      const t = trigger.softDelete('deleted_at');
      expect(t.kind).toBe('soft_delete');
      expect(t.column).toBe('deleted_at');
    });
  });

  describe('trigger.auditLog()', () => {
    it('should create an audit log trigger rule', () => {
      const t = trigger.auditLog({ table: 'audit_log' });
      expect(t.kind).toBe('audit_log');
      expect(t.table).toBe('audit_log');
      expect(t.columns).toBeUndefined();
    });

    it('should accept specific columns to track', () => {
      const t = trigger.auditLog({
        table: 'audit_log',
        columns: ['name', 'email'],
      });
      expect(t.columns).toEqual(['name', 'email']);
    });
  });

  describe('trigger.custom()', () => {
    it('should create a custom trigger rule', () => {
      const t = trigger.custom({
        name: 'validate_status',
        events: ['before_update'],
        functionBody: 'RETURN NEW;',
      });
      expect(t.kind).toBe('custom');
      expect(t.name).toBe('validate_status');
      expect(t.events).toEqual(['before_update']);
      expect(t.functionBody).toBe('RETURN NEW;');
      expect(t.when).toBeUndefined();
      expect(t.forEach).toBeUndefined();
    });

    it('should accept when condition and forEach', () => {
      const t = trigger.custom({
        name: 'check',
        events: ['before_insert', 'before_update'],
        functionBody: 'RETURN NEW;',
        when: 'NEW.status IS NOT NULL',
        forEach: 'row',
      });
      expect(t.when).toBe('NEW.status IS NOT NULL');
      expect(t.forEach).toBe('row');
      expect(t.events).toHaveLength(2);
    });
  });
});

describe('Supabase Adapter - Trigger SQL Generation', () => {
  const adapter = new SupabaseAdapter({
    policyPrefix: 'accessnexus',
    timestamps: false,
  });

  describe('generateTriggers()', () => {
    it('should generate trigger SQL files for tables with triggers', () => {
      const schema = defineSchema({
        profiles: table({
          columns: { id: 'uuid', updated_at: 'timestamptz' },
          primaryKey: 'id',
          triggers: [trigger.updatedAt('updated_at')],
        }),
      });

      const outputs = adapter.generateTriggers(schema);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].path).toBe('profiles_triggers.sql');
    });

    it('should skip tables without triggers', () => {
      const schema = defineSchema({
        users: table({
          columns: { id: 'uuid' },
          policies: { select: policy.isAuthenticated() },
        }),
      });

      const outputs = adapter.generateTriggers(schema);
      expect(outputs).toHaveLength(0);
    });
  });

  describe('updatedAt trigger SQL', () => {
    it('should generate function and trigger', () => {
      const schema = defineSchema({
        profiles: table({
          columns: { id: 'uuid', updated_at: 'timestamptz' },
          primaryKey: 'id',
          triggers: [trigger.updatedAt('updated_at')],
        }),
      });

      const sql = adapter.generateTriggers(schema)[0].content;

      // Function
      expect(sql).toContain('CREATE OR REPLACE FUNCTION accessnexus_profiles_updated_at_fn()');
      expect(sql).toContain('RETURNS TRIGGER');
      expect(sql).toContain('SET search_path = pg_catalog, public');
      expect(sql).toContain('NEW.updated_at = NOW()');
      expect(sql).toContain('RETURN NEW');
      expect(sql).toContain('LANGUAGE plpgsql');

      // Trigger
      expect(sql).toContain('DROP TRIGGER IF EXISTS accessnexus_profiles_updated_at ON profiles');
      expect(sql).toContain('CREATE TRIGGER accessnexus_profiles_updated_at');
      expect(sql).toContain('BEFORE UPDATE ON profiles');
      expect(sql).toContain('FOR EACH ROW');
      expect(sql).toContain('EXECUTE FUNCTION accessnexus_profiles_updated_at_fn()');
    });
  });

  describe('softDelete trigger SQL', () => {
    it('should generate function that cancels DELETE', () => {
      const schema = defineSchema({
        posts: table({
          columns: { id: 'uuid', deleted_at: 'timestamptz?' },
          primaryKey: 'id',
          triggers: [trigger.softDelete('deleted_at')],
        }),
      });

      const sql = adapter.generateTriggers(schema)[0].content;

      expect(sql).toContain('CREATE OR REPLACE FUNCTION accessnexus_posts_soft_delete_fn()');
      expect(sql).toContain('UPDATE public.posts SET deleted_at = NOW() WHERE id = OLD.id');
      expect(sql).toContain('SECURITY DEFINER');
      expect(sql).toContain('SET search_path = pg_catalog, public');
      expect(sql).toContain('RETURN NULL');
      expect(sql).toContain('BEFORE DELETE ON posts');
      expect(sql).toContain('EXECUTE FUNCTION accessnexus_posts_soft_delete_fn()');
    });

    it('guards the column so API users cannot soft-delete or restore with UPDATE', () => {
      const schema = defineSchema({
        posts: table({
          columns: { id: 'uuid', deleted_at: 'timestamptz?' },
          primaryKey: 'id',
          softDelete: 'deleted_at',
        }),
      });

      const sql = adapter.generateTriggers(schema)[0].content;
      const guard = sql.slice(sql.indexOf('accessnexus_posts_soft_delete_guard_fn'));
      expect(guard).toContain(
        "IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND current_user IN ('anon', 'authenticated') THEN",
      );
      expect(guard).toContain("USING ERRCODE = '42501'");
      expect(guard).toContain('BEFORE UPDATE OF deleted_at ON posts');
      // The guard runs as the caller (INVOKER) so current_user is the API role;
      // inside the SECURITY DEFINER soft-delete function it is the owner.
      const guardFn = guard.slice(0, guard.indexOf('CREATE TRIGGER'));
      expect(guardFn).not.toContain('SECURITY DEFINER');
      expect(guardFn).toContain('SET search_path = pg_catalog, public');
    });

    it('should use the correct primary key', () => {
      const schema = defineSchema({
        items: table({
          columns: { item_id: 'uuid', deleted_at: 'timestamptz?' },
          primaryKey: 'item_id',
          triggers: [trigger.softDelete('deleted_at')],
        }),
      });

      const sql = adapter.generateTriggers(schema)[0].content;
      expect(sql).toContain('WHERE item_id = OLD.item_id');
    });
  });

  describe('auditLog trigger SQL', () => {
    it('should generate audit log function with full row logging', () => {
      const schema = defineSchema({
        orders: table({
          columns: { id: 'uuid', total: 'float' },
          triggers: [trigger.auditLog({ table: 'audit_log' })],
        }),
      });

      const sql = adapter.generateTriggers(schema)[0].content;

      expect(sql).toContain('CREATE OR REPLACE FUNCTION accessnexus_orders_audit_log_fn()');
      expect(sql).toContain('INSERT INTO public.audit_log');
      expect(sql).toContain('SECURITY DEFINER');
      expect(sql).toContain('table_name, operation, old_data, new_data, changed_at');
      expect(sql).toContain('TG_TABLE_NAME');
      expect(sql).toContain('TG_OP');
      expect(sql).toContain('TO_JSONB(OLD)');
      expect(sql).toContain('TO_JSONB(NEW)');
      expect(sql).toContain('AFTER INSERT OR UPDATE OR DELETE ON orders');
    });

    it('should generate audit log with specific columns', () => {
      const schema = defineSchema({
        orders: table({
          columns: { id: 'uuid', total: 'float', status: 'text' },
          triggers: [trigger.auditLog({ table: 'audit_log', columns: ['total', 'status'] })],
        }),
      });

      const sql = adapter.generateTriggers(schema)[0].content;

      expect(sql).toContain("JSONB_BUILD_OBJECT('total', OLD.total, 'status', OLD.status)");
      expect(sql).toContain("JSONB_BUILD_OBJECT('total', NEW.total, 'status', NEW.status)");
    });
  });

  describe('lockColumns trigger SQL', () => {
    it('raises when a locked column changes for an API role', () => {
      const schema = defineSchema({
        tasks: table({
          columns: { id: 'uuid', reporter_id: 'uuid', org_id: 'uuid', title: 'text' },
          primaryKey: 'id',
          triggers: [trigger.lockColumns({ columns: ['reporter_id', 'org_id'] })],
        }),
      });
      const sql = adapter.generateTriggers(schema)[0].content;
      expect(sql).toContain('CREATE OR REPLACE FUNCTION accessnexus_tasks_lock_columns_fn()');
      expect(sql).toContain("current_user IN ('anon', 'authenticated')");
      expect(sql).toContain('(NEW.reporter_id IS DISTINCT FROM OLD.reporter_id OR NEW.org_id IS DISTINCT FROM OLD.org_id)');
      expect(sql).toContain("RAISE EXCEPTION 'tasks: reporter_id, org_id cannot be changed'");
      expect(sql).toContain("USING ERRCODE = '42501'");
      expect(sql).toContain('BEFORE UPDATE ON tasks');
      expect(sql).not.toContain('SECURITY DEFINER');
      expect(sql).toContain('SET search_path = pg_catalog, public');
    });

    it('locks every column except the listed ones (and updatedAt columns), with an unless escape', () => {
      const schema = defineSchema({
        tasks: table({
          columns: { id: 'uuid', status: 'text', title: 'text', updated_at: 'timestamptz?' },
          primaryKey: 'id',
          triggers: [
            trigger.updatedAt('updated_at'),
            trigger.lockColumns({ name: 'status_only', except: ['status'], unless: 'OLD.title IS NULL' }),
          ],
        }),
      });
      const sql = adapter.generateTriggers(schema)[0].content;
      expect(sql).toContain("(to_jsonb(NEW) - ARRAY['status', 'updated_at']::text[]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'updated_at']::text[])");
      expect(sql).toContain('NOT COALESCE((OLD.title IS NULL), FALSE)');
      expect(sql).toContain('CREATE TRIGGER accessnexus_tasks_status_only');
      expect(sql).toContain("RAISE EXCEPTION 'tasks: only status can be changed'");
    });
  });

  describe('custom trigger SQL', () => {
    it('runs as SECURITY DEFINER only when asked', () => {
      const schema = (security?: 'invoker' | 'definer') => defineSchema({
        teams: table({
          columns: { id: 'uuid', created_by: 'uuid' },
          primaryKey: 'id',
          triggers: [trigger.custom({
            name: 'add_creator',
            events: ['after_insert'],
            functionBody: "INSERT INTO team_members (team_id, user_id) VALUES (NEW.id, NEW.created_by); RETURN NEW;",
            ...(security ? { security } : {}),
          })],
        }),
      });
      expect(adapter.generateTriggers(schema())[0].content).not.toContain('SECURITY DEFINER');
      expect(adapter.generateTriggers(schema('invoker'))[0].content).not.toContain('SECURITY DEFINER');
      const definer = adapter.generateTriggers(schema('definer'))[0].content;
      expect(definer).toContain('$$ LANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = pg_catalog, public;');
    });

    it('should generate custom function and trigger', () => {
      const schema = defineSchema({
        tasks: table({
          columns: { id: 'uuid', status: 'text' },
          triggers: [
            trigger.custom({
              name: 'validate_status',
              events: ['before_update'],
              functionBody: `
                IF OLD.status = 'done' THEN
                  RAISE EXCEPTION 'Cannot modify done tasks';
                END IF;
                RETURN NEW;`,
            }),
          ],
        }),
      });

      const sql = adapter.generateTriggers(schema)[0].content;

      expect(sql).toContain('CREATE OR REPLACE FUNCTION accessnexus_tasks_validate_status_fn()');
      expect(sql).toContain("RAISE EXCEPTION 'Cannot modify done tasks'");
      expect(sql).toContain('RETURN NEW');
      expect(sql).toContain('BEFORE UPDATE ON tasks');
      expect(sql).toContain('EXECUTE FUNCTION accessnexus_tasks_validate_status_fn()');
    });

    it('should include WHEN clause when specified', () => {
      const schema = defineSchema({
        tasks: table({
          columns: { id: 'uuid', status: 'text' },
          triggers: [
            trigger.custom({
              name: 'check',
              events: ['before_update'],
              functionBody: 'RETURN NEW;',
              when: 'OLD.status IS DISTINCT FROM NEW.status',
            }),
          ],
        }),
      });

      const sql = adapter.generateTriggers(schema)[0].content;
      expect(sql).toContain('WHEN (OLD.status IS DISTINCT FROM NEW.status)');
    });

    it('should support FOR EACH STATEMENT', () => {
      const schema = defineSchema({
        tasks: table({
          columns: { id: 'uuid' },
          triggers: [
            trigger.custom({
              name: 'log',
              events: ['after_insert'],
              functionBody: 'RETURN NEW;',
              forEach: 'statement',
            }),
          ],
        }),
      });

      const sql = adapter.generateTriggers(schema)[0].content;
      expect(sql).toContain('FOR EACH STATEMENT');
    });

    it('should support multiple events', () => {
      const schema = defineSchema({
        tasks: table({
          columns: { id: 'uuid' },
          triggers: [
            trigger.custom({
              name: 'log',
              events: ['after_insert', 'after_update'],
              functionBody: 'RETURN NEW;',
            }),
          ],
        }),
      });

      const sql = adapter.generateTriggers(schema)[0].content;
      expect(sql).toContain('AFTER INSERT OR UPDATE ON tasks');
    });
  });

  describe('multiple triggers per table', () => {
    it('should generate all triggers in one file', () => {
      const schema = defineSchema({
        posts: table({
          columns: { id: 'uuid', updated_at: 'timestamptz', deleted_at: 'timestamptz?' },
          primaryKey: 'id',
          triggers: [
            trigger.updatedAt('updated_at'),
            trigger.softDelete('deleted_at'),
          ],
        }),
      });

      const outputs = adapter.generateTriggers(schema);
      expect(outputs).toHaveLength(1);

      const sql = outputs[0].content;
      expect(sql).toContain('accessnexus_posts_updated_at');
      expect(sql).toContain('accessnexus_posts_soft_delete');
    });
  });

  describe('idempotency', () => {
    it('should include DROP TRIGGER IF EXISTS by default', () => {
      const schema = defineSchema({
        t: table({
          columns: { id: 'uuid', updated_at: 'timestamptz' },
          triggers: [trigger.updatedAt('updated_at')],
        }),
      });

      const sql = adapter.generateTriggers(schema)[0].content;
      expect(sql).toContain('DROP TRIGGER IF EXISTS');
      expect(sql).toContain('CREATE OR REPLACE FUNCTION');
    });

    it('should omit DROP when idempotent is false', () => {
      const nonIdempotent = new SupabaseAdapter({
        policyPrefix: 'accessnexus',
        timestamps: false,
        idempotent: false,
      });

      const schema = defineSchema({
        t: table({
          columns: { id: 'uuid', updated_at: 'timestamptz' },
          triggers: [trigger.updatedAt('updated_at')],
        }),
      });

      const sql = nonIdempotent.generateTriggers(schema)[0].content;
      expect(sql).not.toContain('DROP TRIGGER IF EXISTS');
      // Functions still use CREATE OR REPLACE (always idempotent)
      expect(sql).toContain('CREATE OR REPLACE FUNCTION');
    });
  });
});
