import { describe, it, expect } from 'vitest';
import { defineSchema, table } from '../core/schema/builders.js';
import { policy } from '../core/policy/builders.js';

describe('Schema Builders', () => {
  describe('table()', () => {
    it('should create a basic table definition', () => {
      const t = table({
        columns: {
          id: 'uuid',
          name: 'text',
        },
        primaryKey: 'id',
      });
      expect(t.columns.id).toBe('uuid');
      expect(t.primaryKey).toBe('id');
    });

    it('should auto-enable RLS when policies are defined', () => {
      const t = table({
        columns: { id: 'uuid' },
        policies: {
          select: policy.isAuthenticated(),
        },
      });
      expect(t.enableRLS).toBe(true);
    });

    it('should not auto-enable RLS without policies', () => {
      const t = table({
        columns: { id: 'uuid' },
      });
      expect(t.enableRLS).toBeUndefined();
    });

    it('should handle nullable columns', () => {
      const t = table({
        columns: {
          id: 'uuid',
          bio: 'text?',
          score: 'int?',
        },
      });
      expect(t.columns.bio).toBe('text?');
      expect(t.columns.score).toBe('int?');
    });

    it('should handle column def objects', () => {
      const t = table({
        columns: {
          id: 'uuid',
          email: { type: 'text', unique: true },
          status: { type: 'text', default: 'active' },
        },
      });
      expect((t.columns.email as any).unique).toBe(true);
      expect((t.columns.status as any).default).toBe('active');
    });

    it('should auto-add soft delete trigger when softDelete is configured', () => {
      const t = table({
        columns: {
          id: 'uuid',
          deleted_at: 'timestamptz?',
        },
        softDelete: 'deleted_at',
      });

      expect(t.triggers).toHaveLength(1);
      expect(t.triggers?.[0]).toEqual({
        kind: 'soft_delete',
        column: 'deleted_at',
      });
    });

    it('should not duplicate soft delete trigger if already provided', () => {
      const t = table({
        columns: {
          id: 'uuid',
          deleted_at: 'timestamptz?',
        },
        softDelete: 'deleted_at',
        triggers: [
          { kind: 'soft_delete', column: 'deleted_at' } as any,
        ],
      });

      expect(t.triggers).toHaveLength(1);
    });
  });

  describe('defineSchema()', () => {
    it('should create a valid schema', () => {
      const schema = defineSchema({
        users: table({
          columns: {
            id: 'uuid',
            name: 'text',
          },
          primaryKey: 'id',
        }),
        posts: table({
          columns: {
            id: 'uuid',
            user_id: 'uuid',
            title: 'text',
          },
          primaryKey: 'id',
          references: {
            user_id: 'users.id',
          },
        }),
      });

      expect(Object.keys(schema)).toEqual(['users', 'posts']);
      expect(schema.posts.references?.user_id).toBe('users.id');
    });

    it('should allow external schema references (auth.users)', () => {
      const schema = defineSchema({
        profiles: table({
          columns: {
            id: 'uuid',
            name: 'text',
          },
          primaryKey: 'id',
          references: {
            id: 'auth.users.id',
          },
        }),
      });

      expect(schema.profiles.references?.id).toBe('auth.users.id');
    });

    it('should throw on invalid column reference', () => {
      expect(() => {
        defineSchema({
          users: table({
            columns: { id: 'uuid' },
            references: {
              nonexistent: 'other.id',
            } as any,
          }),
        });
      }).toThrow('reference column "nonexistent" does not exist');
    });

    it('should throw on invalid reference format', () => {
      expect(() => {
        defineSchema({
          users: table({
            columns: { id: 'uuid' },
            references: {
              id: 'invalid',
            },
          }),
        });
      }).toThrow('invalid reference "invalid"');
    });

    it('should throw on referencing non-existent table', () => {
      expect(() => {
        defineSchema({
          posts: table({
            columns: {
              id: 'uuid',
              user_id: 'uuid',
            },
            references: {
              user_id: 'users.id',
            },
          }),
        });
      }).toThrow('references table "users" which is not defined');
    });

    it('should throw on invalid table identifier casing', () => {
      expect(() => {
        defineSchema({
          Users: table({
            columns: { id: 'uuid' },
          }),
        } as any);
      }).toThrow('Use lowercase snake_case');
    });

    it('should throw on invalid column identifier casing', () => {
      expect(() => {
        defineSchema({
          users: table({
            columns: { userId: 'uuid' } as any,
          }),
        });
      }).toThrow('Use lowercase snake_case');
    });

    it('should support full schema with policies', () => {
      const schema = defineSchema({
        profiles: table({
          columns: {
            id: 'uuid',
            name: 'text',
            email: 'text',
            role: 'text',
            shop_id: 'uuid?',
          },
          primaryKey: 'id',
          references: {
            id: 'auth.users.id',
          },
          policies: {
            select: policy.any([
              policy.isOwner('id'),
              policy.hasRole('admin'),
            ]),
            insert: policy.isAuthenticated(),
            update: policy.isOwner('id'),
            delete: policy.none(),
          },
        }),
      });

      expect(schema.profiles.policies?.select?.kind).toBe('any');
      expect(schema.profiles.policies?.delete?.kind).toBe('none');
    });

    it('should apply softDelete trigger even without table() helper', () => {
      const schema = defineSchema({
        posts: {
          columns: {
            id: 'uuid',
            deleted_at: 'timestamptz?',
          },
          softDelete: 'deleted_at',
        } as any,
      });

      expect(schema.posts.triggers).toHaveLength(1);
      expect(schema.posts.triggers?.[0]).toEqual({
        kind: 'soft_delete',
        column: 'deleted_at',
      });
    });
  });
});
