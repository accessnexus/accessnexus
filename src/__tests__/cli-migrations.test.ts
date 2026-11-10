import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SupabaseAdapter } from '../adapters/supabase/adapter.js';
import { defineSchema, table } from '../core/schema/builders.js';
import { resolveVersionedMigrations } from '../cli/migrations.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'accessnexus-migrations-'));
  tempDirs.push(dir);
  return dir;
}

function buildSchema() {
  return defineSchema({
    profiles: table({
      columns: {
        id: 'uuid',
        name: 'text',
      },
      primaryKey: 'id',
    }),
  });
}

describe('CLI migrations snapshot', () => {
  it('creates timestamped initial migration and .snapshot.json on first run', () => {
    const dir = createTempDir();
    mkdirSync(dir, { recursive: true });
    const adapter = new SupabaseAdapter({ timestamps: false });

    const outputs = resolveVersionedMigrations(buildSchema(), adapter, dir);

    expect(outputs).toHaveLength(2);
    expect(outputs[0].path).toMatch(/^\d{14}__init(?:_\d{2})?\.sql$/);
    expect(outputs[1].path).toBe('.snapshot.json');
  });

  it('a table added in a __changes migration also defaults to the v7 helper (and defines it)', () => {
    const dir = createTempDir();
    const adapter = new SupabaseAdapter({ timestamps: false, uuidGeneration: 'v7' });
    for (const file of resolveVersionedMigrations(buildSchema(), adapter, dir)) {
      writeFileSync(join(dir, file.path), file.content, 'utf-8');
    }
    const next = defineSchema({
      ...buildSchema(),
      tags: table({ columns: { id: 'uuid', name: 'text' }, primaryKey: 'id' }),
    });
    const [changes] = resolveVersionedMigrations(next, adapter, dir);
    expect(changes.path).toMatch(/__changes/);
    expect(changes.content).toContain('id UUID DEFAULT public.accessnexus_uuidv7() PRIMARY KEY');
    expect(changes.content.indexOf('CREATE OR REPLACE FUNCTION public.accessnexus_uuidv7()'))
      .toBeLessThan(changes.content.indexOf('CREATE TABLE IF NOT EXISTS tags'));
    expect(changes.content).toContain('REVOKE EXECUTE ON FUNCTION public.accessnexus_uuidv7() FROM PUBLIC, anon;');
  });

  it('returns no migration when snapshot hash matches', () => {
    const dir = createTempDir();
    mkdirSync(dir, { recursive: true });
    const adapter = new SupabaseAdapter({ timestamps: false });

    const first = resolveVersionedMigrations(buildSchema(), adapter, dir);
    for (const file of first) {
      writeFileSync(join(dir, file.path), file.content, 'utf-8');
    }

    const second = resolveVersionedMigrations(buildSchema(), adapter, dir);
    expect(second).toHaveLength(0);
  });

  it('returns no migration when schema is unchanged even with timestamps enabled', () => {
    const dir = createTempDir();
    mkdirSync(dir, { recursive: true });
    const adapter = new SupabaseAdapter({ timestamps: true });

    const first = resolveVersionedMigrations(buildSchema(), adapter, dir);
    for (const file of first) {
      writeFileSync(join(dir, file.path), file.content, 'utf-8');
    }

    const second = resolveVersionedMigrations(buildSchema(), adapter, dir);
    expect(second).toHaveLength(0);
  });

  it('creates timestamped migration when schema changes', () => {
    const dir = createTempDir();
    mkdirSync(dir, { recursive: true });
    const adapter = new SupabaseAdapter({ timestamps: false });

    const first = resolveVersionedMigrations(buildSchema(), adapter, dir);
    for (const file of first) {
      writeFileSync(join(dir, file.path), file.content, 'utf-8');
    }

    const changedSchema = defineSchema({
      profiles: table({
        columns: {
          id: 'uuid',
          name: 'text',
          email: 'text?',
        },
        primaryKey: 'id',
      }),
    });

    const second = resolveVersionedMigrations(changedSchema, adapter, dir);
    expect(second).toHaveLength(2);
    expect(second[0].path).toMatch(/^\d{14}__changes(?:_\d{2})?\.sql$/);
    expect(second[1].path).toBe('.snapshot.json');
    expect(second[0].content).toContain('ALTER TABLE profiles ADD COLUMN IF NOT EXISTS email TEXT;');
    expect(second[0].content).not.toContain('CREATE TABLE IF NOT EXISTS profiles');
  });

  it('detects table rename and emits RENAME TABLE', () => {
    const dir = createTempDir();
    mkdirSync(dir, { recursive: true });
    const adapter = new SupabaseAdapter({ timestamps: false });

    const oldSchema = defineSchema({
      users: table({
        columns: {
          id: 'uuid',
          email: 'text',
        },
        primaryKey: 'id',
      }),
    });

    const first = resolveVersionedMigrations(oldSchema, adapter, dir);
    for (const file of first) {
      writeFileSync(join(dir, file.path), file.content, 'utf-8');
    }

    const newSchema = defineSchema({
      profiles: table({
        columns: {
          id: 'uuid',
          email: 'text',
        },
        primaryKey: 'id',
      }),
    });

    const second = resolveVersionedMigrations(newSchema, adapter, dir);
    expect(second[0].path).toMatch(/^\d{14}__changes(?:_\d{2})?\.sql$/);
    expect(second[0].content).toContain('ALTER TABLE users RENAME TO profiles;');
    expect(second[0].content).not.toContain('DROP TABLE IF EXISTS users');
    expect(second[0].content).not.toContain('CREATE TABLE IF NOT EXISTS profiles');
  });

  it('detects column rename and emits RENAME COLUMN', () => {
    const dir = createTempDir();
    mkdirSync(dir, { recursive: true });
    const adapter = new SupabaseAdapter({ timestamps: false });

    const oldSchema = defineSchema({
      profiles: table({
        columns: {
          id: 'uuid',
          full_name: 'text',
        },
        primaryKey: 'id',
      }),
    });

    const first = resolveVersionedMigrations(oldSchema, adapter, dir);
    for (const file of first) {
      writeFileSync(join(dir, file.path), file.content, 'utf-8');
    }

    const newSchema = defineSchema({
      profiles: table({
        columns: {
          id: 'uuid',
          name: 'text',
        },
        primaryKey: 'id',
      }),
    });

    const second = resolveVersionedMigrations(newSchema, adapter, dir);
    expect(second[0].path).toMatch(/^\d{14}__changes(?:_\d{2})?\.sql$/);
    expect(second[0].content).toContain('ALTER TABLE profiles RENAME COLUMN full_name TO name;');
    expect(second[0].content).not.toContain('DROP COLUMN IF EXISTS full_name');
    expect(second[0].content).not.toContain('ADD COLUMN name TEXT');
  });

  it('adds new constraints with idempotent DO blocks', () => {
    const dir = createTempDir();
    mkdirSync(dir, { recursive: true });
    const adapter = new SupabaseAdapter({ timestamps: false });

    const oldSchema = defineSchema({
      profiles: table({
        columns: {
          id: 'uuid',
          email: 'text',
        },
        primaryKey: 'id',
      }),
    });

    const first = resolveVersionedMigrations(oldSchema, adapter, dir);
    for (const file of first) {
      writeFileSync(join(dir, file.path), file.content, 'utf-8');
    }

    const newSchema = defineSchema({
      profiles: table({
        columns: {
          id: 'uuid',
          email: { type: 'text', unique: true },
        },
        primaryKey: 'id',
      }),
    });

    const second = resolveVersionedMigrations(newSchema, adapter, dir);
    expect(second[0].content).toContain('DO $$');
    expect(second[0].content).toContain("WHERE conname = 'uq_profiles_email'");
    expect(second[0].content).toContain('ADD CONSTRAINT uq_profiles_email UNIQUE (email);');
  });
});

describe('foreign key ON DELETE', () => {
  const schema = (onDelete?: 'cascade') => defineSchema({
    projects: table({ columns: { id: 'uuid' }, primaryKey: 'id' }),
    tasks: table({
      columns: { id: 'uuid', project_id: 'uuid' },
      primaryKey: 'id',
      references: { project_id: 'projects.id' },
      ...(onDelete ? { onDelete: { project_id: onDelete } } : {}),
    }),
  });

  it('emits ON DELETE in the initial DDL (column and table-level forms)', () => {
    const adapter = new SupabaseAdapter({ timestamps: false });
    const ddl = adapter.generateMigrations(schema('cascade'))[0].content;
    expect(ddl).toContain('project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE');

    const columnForm = adapter.generateMigrations(defineSchema({
      orgs: table({ columns: { id: 'uuid' }, primaryKey: 'id' }),
      members: table({
        columns: { id: 'uuid', org_id: { type: 'uuid?', references: 'orgs.id', onDelete: 'set null' } },
        primaryKey: 'id',
      }),
    }))[0].content;
    expect(columnForm).toContain('org_id UUID REFERENCES orgs(id) ON DELETE SET NULL');
  });

  it('replaces the foreign key (including the inline default-named one) when onDelete changes', () => {
    const dir = createTempDir();
    const adapter = new SupabaseAdapter({ timestamps: false });
    for (const file of resolveVersionedMigrations(schema(), adapter, dir)) {
      writeFileSync(join(dir, file.path), file.content, 'utf-8');
    }
    const changes = resolveVersionedMigrations(schema('cascade'), adapter, dir);
    const sql = changes.find((file) => file.path.endsWith('__changes.sql'))!.content;
    expect(sql).toContain('ALTER TABLE tasks DROP CONSTRAINT IF EXISTS fk_tasks_project_id;');
    expect(sql).toContain('ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_project_id_fkey;');
    expect(sql).toContain('FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE');
  });
});

describe('splitSqlStatements', () => {
  it('splits on ; outside quotes, dollar bodies and comments, with start lines', async () => {
    const { splitSqlStatements } = await import('../cli/run.js');
    const sql = `-- header\nCREATE TABLE a (x text DEFAULT 'a;b');\n\nCREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN 1; -- ;\nEND;\n$$;\n/* ; */ SELECT ";" ;`;
    expect(splitSqlStatements(sql)).toEqual([
      { line: 2, sql: "CREATE TABLE a (x text DEFAULT 'a;b');" },
      { line: 4, sql: 'CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN 1; -- ;\nEND;\n$$;' },
      { line: 9, sql: '/* ; */ SELECT ";" ;' },
    ]);
  });
});

describe('findNotNullColumnAdds', () => {
  it('flags NOT NULL adds without a default only', async () => {
    const { findNotNullColumnAdds } = await import('../cli/destructive.js');
    const sql = [
      'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS org_id UUID NOT NULL;',
      "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'todo';",
      'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS note TEXT;',
    ].join('\n');
    expect(findNotNullColumnAdds('m.sql', sql)).toEqual([
      { file: 'm.sql', line: 1, table: 'tasks', column: 'org_id', sql: 'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS org_id UUID NOT NULL;' },
    ]);
  });
});

describe('index names', () => {
  it('come from the content: reordering indexes generates no DDL, old position names are renamed', async () => {
    const { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { defineSchema, table } = await import('../core/schema/builders.js');
    const { SupabaseAdapter } = await import('../adapters/supabase/adapter.js');
    const { resolveVersionedMigrations } = await import('../cli/migrations.js');
    const dir = mkdtempSync(join(tmpdir(), 'accessnexus-idx-'));
    try {
      const schema = (indexes: Array<{ columns: string[]; unique?: boolean }>) => defineSchema({
        orgs: table({ columns: { id: 'uuid' }, primaryKey: 'id' }),
        tasks: table({ columns: { id: 'uuid', org_id: 'uuid', status: 'text', project_id: 'uuid' }, primaryKey: 'id', references: { org_id: 'orgs.id' }, indexes }),
      });
      const write = (s: ReturnType<typeof schema>) => {
        for (const f of resolveVersionedMigrations(s, new SupabaseAdapter({ deterministic: true }), dir)) writeFileSync(join(dir, f.path), f.content);
      };
      const a = [{ columns: ['org_id', 'status'] }, { columns: ['project_id'] }];
      write(schema(a));
      const init = readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith('__init.sql'))!), 'utf-8');
      expect(init).toContain('CREATE INDEX IF NOT EXISTS idx_tasks_org_id_status ON tasks(org_id, status);');
      // org_id is covered by (org_id, status): no separate foreign-key index.
      expect(init).not.toContain('idx_tasks_org_id_fk');
      expect(resolveVersionedMigrations(schema([...a].reverse()), new SupabaseAdapter({ deterministic: true }), dir)).toEqual([]);

      // A snapshot from before 0.4.1 (position-based names): renamed, not rebuilt.
      const snapPath = join(dir, '.snapshot.json');
      const snap = JSON.parse(readFileSync(snapPath, 'utf-8'));
      snap.schemaState.tables.tasks.indexes = snap.schemaState.tables.tasks.indexes.map((i: any, n: number) => ({ ...i, name: `${i.name}_${n + 1}` }));
      snap.schemaHash = 'old';
      writeFileSync(snapPath, JSON.stringify(snap));
      const files = resolveVersionedMigrations(schema(a), new SupabaseAdapter({ deterministic: true }), dir);
      const sql = files.find((f) => f.path.endsWith('.sql'))!.content;
      expect(sql).toContain('ALTER INDEX IF EXISTS idx_tasks_org_id_status_1 RENAME TO idx_tasks_org_id_status;');
      expect(sql).not.toMatch(/DROP INDEX|CREATE INDEX/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('linkOwnPackage', () => {
  it('points accessnexus imports at the running package when the schema folder cannot resolve it', async () => {
    const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { linkOwnPackage } = await import('../cli/run.js');
    const dir = mkdtempSync(join(tmpdir(), 'accessnexus-outside-'));
    try {
      const code = 'import { defineSchema } from "accessnexus";\nimport { asUser } from "accessnexus/testing";\nimport x from "zod";';
      const out = linkOwnPackage(code, dir);
      if (existsSync(join(import.meta.dirname, '..', '..', 'dist', 'index.js'))) {
        expect(out).toMatch(/from "file:\/\/.*\/dist\/index\.js"/);
        expect(out).toMatch(/from "file:\/\/.*\/dist\/testing\/index\.js"/);
      }
      expect(out).toContain('import x from "zod";');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
