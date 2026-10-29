import { describe, it, expect } from 'vitest';
import { policy } from '../core/policy/builders.js';

describe('Policy Builders', () => {
  describe('Primitives', () => {
    it('should create authenticated rule', () => {
      const rule = policy.isAuthenticated();
      expect(rule.kind).toBe('authenticated');
    });

    it('should create public rule', () => {
      const rule = policy.public();
      expect(rule.kind).toBe('public');
    });

    it('should create none rule', () => {
      const rule = policy.none();
      expect(rule.kind).toBe('none');
    });

    it('should create owner rule with column', () => {
      const rule = policy.isOwner('user_id');
      expect(rule.kind).toBe('owner');
      expect(rule.column).toBe('user_id');
    });

    it('should create role rule', () => {
      const rule = policy.hasRole('admin');
      expect(rule.kind).toBe('role');
      expect(rule.role).toBe('admin');
    });

    it('should create belongsTo rule', () => {
      const rule = policy.belongsTo('shop_id');
      expect(rule.kind).toBe('belongs_to');
      expect(rule.column).toBe('shop_id');
    });

    it('should create belongsTo rule with through', () => {
      const rule = policy.belongsTo('shop_id', {
        table: 'shop_members',
        foreignKey: 'shop_id',
        localKey: 'user_id',
      });
      expect(rule.kind).toBe('belongs_to');
      expect(rule.through?.table).toBe('shop_members');
    });

    it('should create matchesField rule', () => {
      const rule = policy.matchesField('created_by', 'assigned_to');
      expect(rule.kind).toBe('matches_field');
      expect(rule.fieldA).toBe('created_by');
      expect(rule.fieldB).toBe('assigned_to');
    });

    it('should create custom rule', () => {
      const rule = policy.custom("auth.uid() IN (SELECT admin_id FROM admins)");
      expect(rule.kind).toBe('custom');
      expect(rule.expression).toContain('admin_id');
    });

    it('should create custom rule with adapter hint', () => {
      const rule = policy.custom("auth.uid() = user_id", 'supabase');
      expect(rule.adapter).toBe('supabase');
    });
  });

  describe('Combinators', () => {
    it('should create any (OR) rule', () => {
      const rule = policy.any([
        policy.isOwner('user_id'),
        policy.hasRole('admin'),
      ]);
      expect(rule.kind).toBe('any');
      expect(rule.rules).toHaveLength(2);
      expect(rule.rules[0].kind).toBe('owner');
      expect(rule.rules[1].kind).toBe('role');
    });

    it('should create all (AND) rule', () => {
      const rule = policy.all([
        policy.isAuthenticated(),
        policy.isOwner('user_id'),
      ]);
      expect(rule.kind).toBe('all');
      expect(rule.rules).toHaveLength(2);
    });

    it('should allow nested combinators', () => {
      const rule = policy.any([
        policy.all([
          policy.isAuthenticated(),
          policy.isOwner('user_id'),
        ]),
        policy.hasRole('admin'),
      ]);
      expect(rule.kind).toBe('any');
      expect(rule.rules[0].kind).toBe('all');
    });
  });

  describe('Advanced', () => {
    it('should create withCheck rule', () => {
      const rule = policy.withCheck(
        policy.isOwner('user_id'),
        policy.isAuthenticated(),
      );
      expect(rule.kind).toBe('with_check');
      expect(rule.using.kind).toBe('owner');
      expect(rule.check.kind).toBe('authenticated');
    });
  });
});
