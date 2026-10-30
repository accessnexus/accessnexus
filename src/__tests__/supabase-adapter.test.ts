import { describe, it, expect } from 'vitest';
import { SupabaseAdapter } from '../adapters/supabase/adapter.js';
import { defineSchema, table } from '../core/schema/builders.js';
import { policy } from '../core/policy/builders.js';
import { rpc } from '../core/rpc/builders.js';

describe('Supabase Adapter', () => {
  it('drops the policies of operations that are not in the schema', () => {
    const schema = defineSchema({
      notes: table({ columns: { id: 'uuid', owner_id: 'uuid' }, primaryKey: 'id', policies: { select: policy.isOwner('owner_id') } }),
      locked: table({ columns: { id: 'uuid' }, primaryKey: 'id' }),
    });
    const files = new SupabaseAdapter().generatePolicies(schema);
    const notes = files.find((f) => f.path.includes('notes'))!.content;
    for (const op of ['insert', 'update', 'delete']) {
      expect(notes).toContain(`DROP POLICY IF EXISTS "accessnexus_notes_${op}" ON notes;`);
      expect(notes).not.toContain(`CREATE POLICY "accessnexus_notes_${op}"`);
    }
    const locked = files.find((f) => f.path.includes('locked'))!.content;
    for (const op of ['select', 'insert', 'update', 'delete']) {
      expect(locked).toContain(`DROP POLICY IF EXISTS "accessnexus_locked_${op}" ON locked;`);
    }
  });

  const adapter = new SupabaseAdapter({
    policyPrefix: 'accessnexus',
    timestamps: false, // Disable for deterministic tests
  });

  const testSchema = defineSchema({
    profiles: table({
      columns: {
        id: 'uuid',
        name: 'text',
        email: 'text',
        role: 'text',
        shop_id: 'uuid?',
      },
      primaryKey: 'id',
      references: { id: 'auth.users.id' },
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
    appointments: table({
      columns: {
        id: 'uuid',
        user_id: 'uuid',
        barber_id: 'uuid',
        shop_id: 'uuid',
        date: 'timestamptz',
        status: 'text',
      },
      primaryKey: 'id',
      references: {
        user_id: 'profiles.id',
        barber_id: 'profiles.id',
      },
      policies: {
        select: policy.any([
          policy.isOwner('user_id'),
          policy.isOwner('barber_id'),
        ]),
        insert: policy.isAuthenticated(),
        update: policy.isOwner('user_id'),
        delete: policy.isOwner('user_id'),
      },
    }),
  });

  describe('ruleToSQL()', () => {
    it('should generate authenticated SQL', () => {
      const sql = adapter.ruleToSQL(policy.isAuthenticated());
      expect(sql).toBe('(SELECT auth.uid()) IS NOT NULL');
    });

    it('should generate public SQL', () => {
      const sql = adapter.ruleToSQL(policy.public());
      expect(sql).toBe('TRUE');
    });

    it('should generate none SQL', () => {
      const sql = adapter.ruleToSQL(policy.none());
      expect(sql).toBe('FALSE');
    });

    it('should generate owner SQL', () => {
      const sql = adapter.ruleToSQL(policy.isOwner('user_id'));
      expect(sql).toBe('(SELECT auth.uid()) = user_id');
    });

    it('should generate role SQL from app_metadata (not the Postgres role claim)', () => {
      const sql = adapter.ruleToSQL(policy.hasRole('admin'));
      expect(sql).toBe("((SELECT auth.jwt()) -> 'app_metadata' ->> 'role') = 'admin'");
    });

    it('quotes string literals so a role or where-value cannot inject SQL', () => {
      const injected = adapter.ruleToSQL(policy.hasRole("x' OR true OR 'a'='a"));
      expect(injected).toBe("((SELECT auth.jwt()) -> 'app_metadata' ->> 'role') = 'x'' OR true OR ''a''=''a'");

      const belongs = adapter.ruleToSQL(
        policy.belongsTo('team_id', { table: 'team_members', foreignKey: 'team_id', localKey: 'user_id', where: { role: ["o'brien"], kind: "a'b" } }),
      );
      expect(belongs).toContain("role IN ('o''brien')");
      expect(belongs).toContain("kind = 'a''b'");
    });

    it('withCheck keeps the USING rule in WITH CHECK by default', () => {
      const rule = policy.withCheck(policy.isOwner('author_id'), policy.custom('edited = true'));
      expect(adapter.ruleToSQL(rule)).toBe('(SELECT auth.uid()) = author_id');
      expect(adapter.ruleToCheckSQL(rule)).toBe('((SELECT auth.uid()) = author_id)\n    AND (edited = true)');
    });

    it("withCheck mode 'replace' checks only the new-row rule", () => {
      const rule = policy.withCheck(policy.custom("status = 'draft'"), policy.custom("status IN ('draft','published')"), { mode: 'replace' });
      expect(adapter.ruleToCheckSQL(rule)).toBe("status IN ('draft','published')");
    });

    it('should generate belongsTo SQL with through', () => {
      const sql = adapter.ruleToSQL(
        policy.belongsTo('shop_id', {
          table: 'shop_members',
          foreignKey: 'shop_id',
          localKey: 'user_id',
        })
      );
      expect(sql).toContain('SELECT shop_id FROM shop_members');
      expect(sql).toContain('user_id = (SELECT auth.uid())');
    });

    it('should generate belongsTo SQL without through (default profiles)', () => {
      const sql = adapter.ruleToSQL(policy.belongsTo('shop_id'));
      expect(sql).toContain('SELECT shop_id FROM profiles');
      expect(sql).toContain('id = (SELECT auth.uid())');
    });

    it('should generate custom SQL', () => {
      const sql = adapter.ruleToSQL(policy.custom("created_at > now() - interval '1 day'"));
      expect(sql).toContain("interval '1 day'");
    });

    it('should wrap auth.* calls in matchesField for initPlan optimization', () => {
      const sql = adapter.ruleToSQL(policy.matchesField('author_id', 'auth.uid()'));
      expect(sql).toBe('author_id = (SELECT auth.uid())');
    });

    it('should not wrap plain column matchesField', () => {
      const sql = adapter.ruleToSQL(policy.matchesField('from_id', 'to_id'));
      expect(sql).toBe('from_id = to_id');
    });

    it('should generate OR combination', () => {
      const sql = adapter.ruleToSQL(
        policy.any([
          policy.isOwner('user_id'),
          policy.hasRole('admin'),
        ])
      );
      expect(sql).toContain('(SELECT auth.uid()) = user_id');
      expect(sql).toContain('OR');
      expect(sql).toContain("'admin'");
    });

    it('should generate AND combination', () => {
      const sql = adapter.ruleToSQL(
        policy.all([
          policy.isAuthenticated(),
          policy.isOwner('user_id'),
        ])
      );
      expect(sql).toContain('(SELECT auth.uid()) IS NOT NULL');
      expect(sql).toContain('AND');
      expect(sql).toContain('(SELECT auth.uid()) = user_id');
    });

    it('should handle single-item combinators without wrapping', () => {
      const sql = adapter.ruleToSQL(
        policy.any([policy.isAuthenticated()])
      );
      expect(sql).toBe('(SELECT auth.uid()) IS NOT NULL');
      expect(sql).not.toContain('OR');
    });

    it('should handle nested combinators', () => {
      const sql = adapter.ruleToSQL(
        policy.any([
          policy.all([
            policy.isAuthenticated(),
            policy.isOwner('user_id'),
          ]),
          policy.hasRole('admin'),
        ])
      );
      expect(sql).toContain('AND');
      expect(sql).toContain('OR');
    });
  });

  describe('generatePolicies()', () => {
    it('should generate SQL files for tables with policies', () => {
      const outputs = adapter.generatePolicies(testSchema);
      expect(outputs).toHaveLength(2);
      expect(outputs[0].path).toBe('profiles_rls.sql');
      expect(outputs[1].path).toBe('appointments_rls.sql');
    });

    it('should include ENABLE ROW LEVEL SECURITY', () => {
      const outputs = adapter.generatePolicies(testSchema);
      expect(outputs[0].content).toContain('ALTER TABLE profiles ENABLE ROW LEVEL SECURITY');
      expect(outputs[0].content).toContain('ALTER TABLE profiles FORCE ROW LEVEL SECURITY');
    });

    it('should include DROP IF EXISTS (idempotent)', () => {
      const outputs = adapter.generatePolicies(testSchema);
      expect(outputs[0].content).toContain('DROP POLICY IF EXISTS "accessnexus_profiles_select"');
    });

    it('should generate INSERT with WITH CHECK', () => {
      const outputs = adapter.generatePolicies(testSchema);
      const profilesSQL = outputs[0].content;
      // INSERT should use WITH CHECK, not USING
      const insertSection = profilesSQL.split('FOR INSERT')[1]?.split('CREATE POLICY')[0] ?? '';
      expect(insertSection).toContain('WITH CHECK');
      expect(insertSection).not.toContain('USING');
    });

    it('UPDATE always gets an explicit WITH CHECK (withCheck: USING AND check)', () => {
      const schema = defineSchema({
        comments: table({
          columns: { id: 'uuid', author_id: 'uuid', edited: 'boolean' },
          primaryKey: 'id',
          policies: {
            update: policy.withCheck(policy.isOwner('author_id'), policy.custom('edited = true')),
            delete: policy.isOwner('author_id'),
          },
        }),
      });
      const sql = adapter.generatePolicies(schema)[0].content;
      const update = sql.split('FOR UPDATE')[1].split('DROP POLICY')[0];
      expect(update).toContain('USING (\n    (SELECT auth.uid()) = author_id\n  )');
      expect(update).toContain('WITH CHECK (\n    ((SELECT auth.uid()) = author_id)\n    AND (edited = true)\n  );');

      const simple = adapter.generatePolicies(testSchema)[0].content.split('FOR UPDATE')[1].split('DROP POLICY')[0];
      expect(simple).toContain('WITH CHECK');
    });

    it('restricts EXECUTE on SECURITY DEFINER membership helpers', () => {
      const member = policy.belongsTo('team_id', { table: 'team_members', foreignKey: 'team_id', localKey: 'user_id' });
      const schema = defineSchema({
        docs: table({
          columns: { id: 'uuid', team_id: 'uuid', published: 'boolean' },
          primaryKey: 'id',
          policies: { select: member, update: member },
        }),
        pages: table({
          columns: { id: 'uuid', team_id: 'uuid', published: 'boolean' },
          primaryKey: 'id',
          policies: { select: policy.any([policy.public(), member]) },
        }),
      });
      const [docs, pages] = adapter.generatePolicies(schema).map((file) => file.content);
      expect(docs).toContain('REVOKE EXECUTE ON FUNCTION accessnexus_docs_belongs_to_1_fn(uuid) FROM PUBLIC, anon;');
      expect(docs).toContain('GRANT EXECUTE ON FUNCTION accessnexus_docs_belongs_to_1_fn(uuid) TO authenticated;');
      // Used by a policy TO public: anon keeps EXECUTE.
      expect(pages).toContain('GRANT EXECUTE ON FUNCTION accessnexus_pages_belongs_to_1_fn(uuid) TO authenticated, anon;');
    });

    describe('policy target role (TO public / TO authenticated)', () => {
      const roleOf = (sql: string, op: string) => sql.split(`FOR ${op}`)[1].split('\n')[1].trim();
      const articles = (policies: Record<string, any>) => adapter.generatePolicies(defineSchema({
        articles: table({
          columns: { id: 'uuid', author_id: 'uuid', published: 'boolean' },
          primaryKey: 'id',
          policies,
        }),
      }))[0].content;

      it('lets anon read when any select branch can pass without a user (public-read recipe)', () => {
        const sql = articles({
          select: policy.any([policy.custom('published = true'), policy.isOwner('author_id')]),
          insert: policy.isOwner('author_id'),
          update: policy.isOwner('author_id'),
          delete: policy.isOwner('author_id'),
        });
        expect(roleOf(sql, 'SELECT')).toBe('TO public');
        // Writes stay authenticated-only even though select is public.
        expect(roleOf(sql, 'INSERT')).toBe('TO authenticated');
        expect(roleOf(sql, 'UPDATE')).toBe('TO authenticated');
        expect(roleOf(sql, 'DELETE')).toBe('TO authenticated');
      });

      it('keeps select authenticated when every branch needs a user', () => {
        const sql = articles({
          select: policy.any([policy.isOwner('author_id'), policy.isAuthenticated()]),
        });
        expect(roleOf(sql, 'SELECT')).toBe('TO authenticated');
        const both = articles({ select: policy.all([policy.isAuthenticated(), policy.custom('published = true')]) });
        expect(roleOf(both, 'SELECT')).toBe('TO authenticated');
      });

      it('never opens a write to anon because of a custom branch', () => {
        const sql = articles({
          insert: policy.custom('published = false'),
          update: policy.any([policy.custom('true'), policy.isOwner('author_id')]),
        });
        expect(roleOf(sql, 'INSERT')).toBe('TO authenticated');
        expect(roleOf(sql, 'UPDATE')).toBe('TO authenticated');
      });

      it('grants a write to public only for an explicit policy.public() decision', () => {
        const contactForm = articles({
          insert: policy.all([policy.public(), policy.custom('published = false')]),
          update: policy.all([policy.public(), policy.isOwner('author_id')]),
        });
        expect(roleOf(contactForm, 'INSERT')).toBe('TO public');
        expect(roleOf(contactForm, 'UPDATE')).toBe('TO authenticated');
      });
    });

    it('should generate DELETE with USING', () => {
      const outputs = adapter.generatePolicies(testSchema);
      const profilesSQL = outputs[0].content;
      const deleteSection = profilesSQL.split('FOR DELETE')[1] ?? '';
      expect(deleteSection).toContain('USING');
      expect(deleteSection).toContain('FALSE');
    });

    it('locks tables without policies (RLS on, deny-all) — fails closed', () => {
      const schema = defineSchema({
        logs: table({
          columns: { id: 'uuid', message: 'text' },
        }),
      });
      const outputs = adapter.generatePolicies(schema);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].path).toBe('logs_rls.sql');
      expect(outputs[0].content).toContain('ALTER TABLE logs ENABLE ROW LEVEL SECURITY;');
      expect(outputs[0].content).toContain('ALTER TABLE logs FORCE ROW LEVEL SECURITY;');
      expect(outputs[0].content).not.toContain('CREATE POLICY');
    });

    it('skips RLS only for an explicit enableRLS: false', () => {
      const schema = defineSchema({
        open_logs: table({
          columns: { id: 'uuid', message: 'text' },
          enableRLS: false,
        }),
      });
      expect(adapter.generatePolicies(schema)).toHaveLength(0);
    });
  });

  describe('generateMigrations()', () => {
    it('should generate a single initial migration file', () => {
      const outputs = adapter.generateMigrations(testSchema);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].path).toBe('001_initial.sql');
    });

    it('should generate CREATE TABLE with primary/foreign keys and ordering', () => {
      const outputs = adapter.generateMigrations(testSchema);
      const sql = outputs[0].content;

      expect(sql).toContain('CREATE TABLE IF NOT EXISTS profiles');
      expect(sql).toContain('id UUID DEFAULT gen_random_uuid()');
      expect(sql).toContain('PRIMARY KEY');
      expect(sql).toContain('REFERENCES auth.users(id)');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS appointments');
      expect(sql).toContain('REFERENCES profiles(id)');

      const profilesIndex = sql.indexOf('CREATE TABLE IF NOT EXISTS profiles');
      const appointmentsIndex = sql.indexOf('CREATE TABLE IF NOT EXISTS appointments');
      expect(profilesIndex).toBeLessThan(appointmentsIndex);
    });

    it('should generate defaults, unique, checks, indexes and enum types', () => {
      const schema = defineSchema({
        shops: table({
          columns: {
            id: { type: 'uuid', default: 'gen_random_uuid()' },
            slug: { type: 'text', unique: true },
            role: { type: "enum('admin','member')", default: "'member'" },
            rating: { type: 'decimal', check: 'rating >= 0' },
            owner_id: { type: 'uuid', references: 'profiles.id' },
          },
          primaryKey: 'id',
          indexes: [
            { columns: ['slug'], unique: true },
            { columns: ['owner_id'] },
          ],
        }),
        profiles: table({
          columns: {
            id: 'uuid',
            name: 'text',
          },
          primaryKey: 'id',
        }),
      });

      const outputs = adapter.generateMigrations(schema);
      const sql = outputs[0].content;

      expect(sql).toContain("CREATE TYPE shops_role_enum AS ENUM ('admin', 'member')");
      expect(sql).toContain('role shops_role_enum NOT NULL DEFAULT \'member\'');
      expect(sql).toContain('slug TEXT NOT NULL UNIQUE');
      expect(sql).toContain('rating NUMERIC NOT NULL CHECK (rating >= 0)');
      expect(sql).toContain('owner_id UUID NOT NULL REFERENCES profiles(id)');
      expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_shops_slug_1 ON shops(slug);');
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_shops_owner_id_2 ON shops(owner_id);');
      expect(sql).not.toContain('CREATE INDEX IF NOT EXISTS idx_shops_owner_id_fk ON shops(owner_id);');
    });

    it('should auto-create index for foreign key columns when missing', () => {
      const schema = defineSchema({
        posts: table({
          columns: {
            id: 'uuid',
            author_id: { type: 'uuid', references: 'profiles.id' },
          },
          primaryKey: 'id',
        }),
        profiles: table({
          columns: {
            id: 'uuid',
          },
          primaryKey: 'id',
        }),
      });

      const outputs = adapter.generateMigrations(schema);
      const sql = outputs[0].content;
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_posts_author_id_fk ON posts(author_id);');
    });

    it('does not index a foreign key that is the primary key or unique (already indexed)', () => {
      const schema = defineSchema({
        profiles: table({ columns: { id: 'uuid', handle: { type: 'uuid', unique: true, references: 'auth.users.id' } }, primaryKey: 'id', references: { id: 'auth.users.id' } }),
      });
      const sql = adapter.generateMigrations(schema)[0].content;
      expect(sql).not.toContain('idx_profiles_id_fk');
      expect(sql).not.toContain('idx_profiles_handle_fk');
    });

    it('should auto-create index for columns referenced in RLS policies', () => {
      const schema = defineSchema({
        comments: table({
          columns: {
            id: 'uuid',
            user_id: 'uuid',
            body: 'text',
          },
          primaryKey: 'id',
          policies: {
            select: policy.isOwner('user_id'),
            update: policy.isOwner('user_id'),
            delete: policy.isOwner('user_id'),
          },
        }),
      });

      const outputs = adapter.generateMigrations(schema);
      const sql = outputs[0].content;
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_comments_user_id_rls ON comments(user_id);');
    });

    it('should not duplicate RLS index when column already has FK index', () => {
      const schema = defineSchema({
        posts: table({
          columns: {
            id: 'uuid',
            author_id: { type: 'uuid', references: 'profiles.id' },
          },
          primaryKey: 'id',
          policies: {
            select: policy.isOwner('author_id'),
          },
        }),
        profiles: table({
          columns: { id: 'uuid' },
          primaryKey: 'id',
        }),
      });

      const outputs = adapter.generateMigrations(schema);
      const sql = outputs[0].content;
      // FK index should exist
      expect(sql).toContain('idx_posts_author_id_fk');
      // RLS index should NOT exist (deduped against FK)
      expect(sql).not.toContain('idx_posts_author_id_rls');
    });

    it('should not create RLS index for the primary key column', () => {
      const schema = defineSchema({
        profiles: table({
          columns: {
            id: 'uuid',
            name: 'text',
          },
          primaryKey: 'id',
          policies: {
            select: policy.isOwner('id'),
          },
        }),
      });

      const outputs = adapter.generateMigrations(schema);
      const sql = outputs[0].content;
      expect(sql).not.toContain('idx_profiles_id_rls');
    });

    it('should create RLS indexes for matchesField columns', () => {
      const schema = defineSchema({
        transfers: table({
          columns: {
            id: 'uuid',
            from_id: 'uuid',
            to_id: 'uuid',
          },
          primaryKey: 'id',
          policies: {
            select: policy.matchesField('from_id', 'to_id'),
          },
        }),
      });

      const outputs = adapter.generateMigrations(schema);
      const sql = outputs[0].content;
      expect(sql).toContain('idx_transfers_from_id_rls');
      expect(sql).toContain('idx_transfers_to_id_rls');
    });

    it('should use gen_random_uuid() by default for UUID PKs', () => {
      const schema = defineSchema({
        items: table({
          columns: { id: 'uuid', name: 'text' },
          primaryKey: 'id',
        }),
      });

      const outputs = adapter.generateMigrations(schema);
      const sql = outputs[0].content;
      expect(sql).toContain('DEFAULT gen_random_uuid()');
      expect(sql).not.toContain('accessnexus_uuidv7');
    });

    it('should use accessnexus_uuidv7() when uuidGeneration is v7', () => {
      const v7Adapter = new SupabaseAdapter({
        timestamps: false,
        uuidGeneration: 'v7',
      });

      const schema = defineSchema({
        items: table({
          columns: { id: 'uuid', name: 'text' },
          primaryKey: 'id',
        }),
      });

      const outputs = v7Adapter.generateMigrations(schema);
      const sql = outputs[0].content;
      expect(sql).toContain('CREATE OR REPLACE FUNCTION public.accessnexus_uuidv7()');
      expect(sql).toContain('RETURNS uuid');
      expect(sql).toContain('uuid_send(gen_random_uuid())');
      expect(sql).toContain('DEFAULT public.accessnexus_uuidv7()');
      expect(sql).not.toContain('DEFAULT gen_random_uuid()');
      // Not callable through PostgREST by anon; the inserting roles keep EXECUTE.
      expect(sql).toContain('REVOKE EXECUTE ON FUNCTION public.accessnexus_uuidv7() FROM PUBLIC, anon;');
      expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.accessnexus_uuidv7() TO authenticated, service_role;');
      expect(sql).not.toContain('uuid_generate_v7');
    });

    it('grants the uuidv7 helper to anon only when a v7 table accepts anonymous inserts', () => {
      const v7Adapter = new SupabaseAdapter({ timestamps: false, uuidGeneration: 'v7' });
      const schema = defineSchema({
        leads: table({
          columns: { id: 'uuid', email: 'text' },
          primaryKey: 'id',
          policies: { insert: policy.public() },
        }),
      });
      const sql = v7Adapter.generateMigrations(schema)[0].content;
      expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.accessnexus_uuidv7() TO anon, authenticated, service_role;');
    });

    it('should not generate uuidv7 function when no UUID PKs exist', () => {
      const v7Adapter = new SupabaseAdapter({
        timestamps: false,
        uuidGeneration: 'v7',
      });

      const schema = defineSchema({
        counters: table({
          columns: { id: 'bigint', name: 'text' },
          primaryKey: 'id',
        }),
      });

      const outputs = v7Adapter.generateMigrations(schema);
      const sql = outputs[0].content;
      expect(sql).not.toContain('accessnexus_uuidv7');
    });
  });

  describe('generateClient()', () => {
    it('should generate types and client files', () => {
      const outputs = adapter.generateClient(testSchema);
      expect(outputs).toHaveLength(2);
      expect(outputs[0].path).toBe('types.ts');
      expect(outputs[1].path).toBe('client.ts');
    });

    it('should generate correct TypeScript interfaces', () => {
      const outputs = adapter.generateClient(testSchema);
      const types = outputs[0].content;

      expect(types).toContain('export type Profiles = {');
      expect(types).toContain('id: string;');
      expect(types).toContain('name: string;');
      expect(types).toContain('shop_id: string | null;');
      expect(types).toContain('export type Appointments = {');
      expect(types).toContain('date: string;');
    });

    it('should generate Create and Update types', () => {
      const outputs = adapter.generateClient(testSchema);
      const types = outputs[0].content;

      // nullable columns and the auto-generated uuid PK are optional; the PK can still be set
      expect(types).toContain("export type ProfilesCreate = Pick<Profiles, 'name' | 'email' | 'role'> & Partial<Pick<Profiles, 'id' | 'shop_id'>>;");
      expect(types).toContain("export type ProfilesUpdate = Partial<Omit<Profiles, 'id'>>;");
    });

    it('makes columns with a default optional on create', () => {
      const schema = defineSchema({
        posts: table({
          columns: { id: 'uuid', title: 'text', published: { type: 'boolean', default: 'false' }, created_at: { type: 'timestamptz', default: 'now()' } },
          primaryKey: 'id',
        }),
        tags: table({ columns: { slug: 'text', label: 'text?' }, primaryKey: 'slug' }),
      });
      const types = adapter.generateClient(schema)[0].content;
      expect(types).toContain("export type PostsCreate = Pick<Posts, 'title'> & Partial<Pick<Posts, 'id' | 'published' | 'created_at'>>;");
      // a text primary key has no default, so it stays required
      expect(types).toContain("export type TagsCreate = Pick<Tags, 'slug'> & Partial<Pick<Tags, 'label'>>;");
    });

    it('should generate client with CRUD methods', () => {
      const outputs = adapter.generateClient(testSchema);
      const client = outputs[1].content;

      expect(client).toContain('createAccessNexusClient');
      expect(client).toContain('auth: providerRaw.auth');
      expect(client).toContain('findMany');
      expect(client).toContain('findById');
      expect(client).toContain('create');
      expect(client).toContain('update');
      expect(client).toContain('delete');
    });

    it('should generate relation include types and join select helpers', () => {
      const schema = defineSchema({
        profiles: table({
          columns: {
            id: 'uuid',
            name: 'text',
          },
          primaryKey: 'id',
        }),
        shops: table({
          columns: {
            id: 'uuid',
            name: 'text',
          },
          primaryKey: 'id',
        }),
        appointments: table({
          columns: {
            id: 'uuid',
            profile_id: 'uuid',
            shop_id: 'uuid',
          },
          primaryKey: 'id',
          references: {
            profile_id: 'profiles.id',
            shop_id: 'shops.id',
          },
        }),
      });

      const outputs = adapter.generateClient(schema);
      const client = outputs[1].content;

      expect(client).toContain("type AppointmentsRelations = {");
      expect(client).toContain("'profile': RowOf<'profiles'>;");
      expect(client).toContain("'shop': RowOf<'shops'>;");
      expect(client).toContain("type AppointmentsInclude = Partial<Record<keyof AppointmentsRelations, true>>;");
      expect(client).toContain("const appointmentsJoins: Record<keyof AppointmentsRelations & string, string> = {");
      expect(client).toContain("'profile': 'profile:profiles!appointments_profile_id_fkey(*)'");
      expect(client).toContain("'shop': 'shop:shops!appointments_shop_id_fkey(*)'");
      expect(client).toContain("findMany: <TColumns extends ColumnsOf<'appointments'> | undefined = undefined, TInclude extends AppointmentsInclude | undefined = undefined>(");
      expect(client).toContain("options?: { columns?: TColumns; include?: TInclude },");
      expect(client).toContain("selectClause(options?.columns, appointmentsJoins, options?.include as Record<string, true | undefined> | undefined)");
      expect(client).toContain("as unknown as QueryResult<AppointmentsWithInclude<TInclude, SelectedRow<'appointments', TColumns>>[]>");
    });

    it('should type client with generated Database type for return inference', () => {
      const outputs = adapter.generateClient(testSchema);
      const client = outputs[1].content;
      const types = outputs[0].content;

      expect(types).toContain('export interface Database {');
      expect(types).toContain('Tables: {');
      expect(types).toContain('profiles: {');
      expect(client).toContain("import type { Database, Profiles, ProfilesCreate, ProfilesUpdate, Appointments, AppointmentsCreate, AppointmentsUpdate } from './types.js';");
      expect(client).toContain('type TableName = keyof Tables & string;');
      expect(client).toContain('interface QueryBuilder extends PromiseLike<unknown> {');
      expect(client).toContain('type AccessNexusTransport = {');
      expect(client).toContain('auth: unknown;');
      expect(client).toContain("auth: providerRaw.auth as TClient['auth'],");
      expect(client).toContain("as unknown as QueryResult<Profiles>,");
      expect(client).toContain('createAccessNexusClient<TClient extends AccessNexusProvider>(providerRaw: TClient)');
    });

    it('should export AccessNexusClient type', () => {
      const outputs = adapter.generateClient(testSchema);
      const client = outputs[1].content;
      expect(client).toContain('export type AccessNexusClient<TClient extends AccessNexusProvider = AccessNexusProvider> =\n  ReturnType<typeof createAccessNexusClient<TClient>>;');
    });

    it('should soft-delete on delete() and filter soft-deleted rows when softDelete is set', () => {
      const schema = defineSchema({
        posts: table({
          columns: {
            id: 'uuid',
            title: 'text',
            deleted_at: 'timestamptz?',
          },
          primaryKey: 'id',
          softDelete: 'deleted_at',
        }),
      });

      const outputs = adapter.generateClient(schema);
      const client = outputs[1].content;

      expect(client).toContain(".is('deleted_at', null).match(filter ?? {})");
      expect(client).toContain(".eq('id', id).is('deleted_at', null).maybeSingle()");
      expect(client).toContain(".is('deleted_at', null).match(filter).maybeSingle()");
      // A real DELETE: the soft-delete trigger converts it, so the DELETE policy decides.
      expect(client).toContain("from('posts').delete().eq('id', id)");
      expect(client).not.toContain("['deleted_at']: new Date().toISOString()");
    });

    it('should type RPC args from generated Functions map', () => {
      const schema = defineSchema({
        users: table({
          columns: { id: 'uuid', name: 'text' },
        }),
      }, {
        rpcs: {
          get_stats: rpc({
            args: { user_id: 'uuid' },
            returns: 'jsonb',
          }),
        },
      });

      const outputs = adapter.generateClient(schema);
      const client = outputs[1].content;
      const types = outputs[0].content;

      expect(types).toContain("get_stats: {");
      expect(types).toContain("Args: { user_id: string }");
      expect(types).toContain('Returns: Json;');
      expect(types).toContain('| { [key: string]: Json | undefined }');
      expect(client).toContain("type Functions = Database['public']['Functions'];");
      expect(client).toContain("get_stats: (args: Functions['get_stats']['Args']) =>");
    });
  });

  describe('deterministic output', () => {
    it('produces byte-identical policies across runs', () => {
      const det = new SupabaseAdapter({ deterministic: true });
      const a = det.generatePolicies(testSchema).map((o) => o.content).join('\n');
      const b = det.generatePolicies(testSchema).map((o) => o.content).join('\n');
      expect(a).toBe(b);
      expect(a).not.toContain('Generated at:');
    });

    it('keeps the header title while omitting the timestamp', () => {
      const det = new SupabaseAdapter({ deterministic: true });
      const sql = det.generatePolicies(testSchema)[0].content;
      expect(sql).toContain('AccessNexus: Auto-generated RLS policies');
      expect(sql).not.toContain('Generated at:');
    });

    it('still emits a timestamp by default', () => {
      const stamped = new SupabaseAdapter();
      const sql = stamped.generatePolicies(testSchema)[0].content;
      expect(sql).toContain('Generated at:');
    });
  });
});
