import { describe, it, expect } from 'vitest';
import { SupabaseAdapter } from '../adapters/supabase/adapter.js';
import { defineSchema, table } from '../core/schema/builders.js';
import { policy } from '../core/policy/builders.js';
import type { SeedDef } from '../core/types/seed.js';

describe('Seed Generation', () => {
  const adapter = new SupabaseAdapter({
    policyPrefix: 'accessnexus',
    timestamps: false,
  });

  const testSchema = defineSchema({
    profiles: table({
      columns: {
        id: 'uuid',
        name: 'text',
        email: 'text',
        role: 'text',
      },
      primaryKey: 'id',
    }),
    shops: table({
      columns: {
        id: 'uuid',
        name: 'text',
        owner_id: 'uuid',
        active: 'boolean',
      },
      primaryKey: 'id',
      references: {
        owner_id: 'profiles.id',
      },
    }),
  });

  it('should generate seed SQL for a single table', () => {
    const seedData: SeedDef = {
      profiles: [
        { id: '11111111-1111-1111-1111-111111111111', name: 'Alice', email: 'alice@example.com', role: 'admin' },
      ],
    };

    const outputs = adapter.generateSeed(testSchema, seedData);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].path).toBe('seed.sql');

    const sql = outputs[0].content;
    expect(sql).toContain('INSERT INTO "profiles"');
    expect(sql).toContain("'Alice'");
    expect(sql).toContain("'alice@example.com'");
    expect(sql).toContain('ON CONFLICT ("id")');
    expect(sql).toContain('DO UPDATE SET');
  });

  it('should generate seed SQL for multiple tables', () => {
    const seedData: SeedDef = {
      profiles: [
        { id: 'aaa', name: 'Alice', email: 'alice@test.com', role: 'admin' },
      ],
      shops: [
        { id: 'bbb', name: 'Cool Cuts', owner_id: 'aaa', active: true },
      ],
    };

    const outputs = adapter.generateSeed(testSchema, seedData);
    const sql = outputs[0].content;

    // profiles should come before shops (dependency order)
    const profilesIdx = sql.indexOf('"profiles"');
    const shopsIdx = sql.indexOf('"shops"');
    expect(profilesIdx).toBeLessThan(shopsIdx);
  });

  it('should handle null values', () => {
    const seedData: SeedDef = {
      profiles: [
        { id: 'aaa', name: 'Bob', email: null, role: 'client' },
      ],
    };

    const outputs = adapter.generateSeed(testSchema, seedData);
    const sql = outputs[0].content;
    expect(sql).toContain('NULL');
  });

  it('should handle boolean values', () => {
    const seedData: SeedDef = {
      shops: [
        { id: 'bbb', name: 'Shop', owner_id: 'aaa', active: true },
      ],
    };

    const outputs = adapter.generateSeed(testSchema, seedData);
    const sql = outputs[0].content;
    expect(sql).toContain('TRUE');
  });

  it('should handle numeric values', () => {
    const seedData: SeedDef = {
      profiles: [
        { id: 'aaa', name: 'Test', email: 'test@test.com', role: 'user' },
      ],
    };

    const outputs = adapter.generateSeed(testSchema, seedData);
    const sql = outputs[0].content;
    // Strings should be quoted
    expect(sql).toContain("'Test'");
  });

  it('should handle JSON/object values', () => {
    const seedData: SeedDef = {
      shops: [
        { id: 'bbb', name: 'Shop', owner_id: 'aaa', active: true, settings: { theme: 'dark' } },
      ],
    };

    const outputs = adapter.generateSeed(testSchema, seedData);
    const sql = outputs[0].content;
    expect(sql).toContain('{"theme":"dark"}');
  });

  it('should escape single quotes in string values', () => {
    const seedData: SeedDef = {
      profiles: [
        { id: 'aaa', name: "O'Brien", email: 'ob@test.com', role: 'client' },
      ],
    };

    const outputs = adapter.generateSeed(testSchema, seedData);
    const sql = outputs[0].content;
    expect(sql).toContain("'O''Brien'");
  });

  it('should generate DO NOTHING when only PK columns are present', () => {
    const seedData: SeedDef = {
      profiles: [
        { id: 'aaa' },
      ],
    };

    const outputs = adapter.generateSeed(testSchema, seedData);
    const sql = outputs[0].content;
    expect(sql).toContain('DO NOTHING');
  });

  it('should skip empty seed data', () => {
    const seedData: SeedDef = {
      profiles: [],
    };

    const outputs = adapter.generateSeed(testSchema, seedData);
    const sql = outputs[0].content;
    expect(sql).not.toContain('INSERT INTO');
  });

  it('should handle multiple rows per table', () => {
    const seedData: SeedDef = {
      profiles: [
        { id: 'aaa', name: 'Alice', email: 'a@test.com', role: 'admin' },
        { id: 'bbb', name: 'Bob', email: 'b@test.com', role: 'client' },
        { id: 'ccc', name: 'Charlie', email: 'c@test.com', role: 'barber' },
      ],
    };

    const outputs = adapter.generateSeed(testSchema, seedData);
    const sql = outputs[0].content;
    const insertCount = (sql.match(/INSERT INTO/g) ?? []).length;
    expect(insertCount).toBe(3);
  });

  it('should include tables in seed data not in schema (graceful)', () => {
    const seedData: SeedDef = {
      unknown_table: [
        { id: 'xxx', foo: 'bar' },
      ],
    };

    const outputs = adapter.generateSeed(testSchema, seedData);
    const sql = outputs[0].content;
    expect(sql).toContain('"unknown_table"');
  });
});
