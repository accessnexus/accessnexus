// Round trip of `init --db-url` against a real Supabase Postgres: build a
// database by hand (triggers, `_`-prefixed functions with parameter defaults,
// column defaults, numeric(p,s), enums, arrays, an FK to auth.users, composite
// PK / UNIQUE), import it, then drop it and recreate it with generate + push,
// and compare the catalog before and after.
//
// Skipped unless ACCESSNEXUS_TEST_DB_URL points at a disposable database (see
// the header of push.integration.test.ts for the docker + auth.jwt() setup).
// The test DROPS every table, function and enum type in the public schema.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runCli } from '../cli/run.js';

const DB_URL = process.env.ACCESSNEXUS_TEST_DB_URL;
const SRC_INDEX = resolve(__dirname, '../index.ts').replaceAll('\\', '/');
const USER_ID = '55555555-5555-5555-5555-555555555555';

const FIXTURE = `
CREATE TYPE public.order_status AS ENUM ('pending', 'paid', 'cancelled');

CREATE TABLE public.shops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug varchar NOT NULL UNIQUE,
  tags text[] NOT NULL DEFAULT '{}'::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);

CREATE TABLE public.orders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  total numeric(10,2) NOT NULL DEFAULT 0,
  ratio numeric,
  status public.order_status NOT NULL DEFAULT 'pending'::public.order_status,
  code text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, code)
);

CREATE TABLE public.shop_members (
  shop_id uuid NOT NULL REFERENCES public.shops(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  role text NOT NULL DEFAULT 'member'::text,
  PRIMARY KEY (shop_id, user_id)
);

ALTER TABLE public.shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owners read" ON public.shops FOR SELECT TO authenticated USING ((SELECT auth.uid()) = owner_id);

CREATE FUNCTION public._pix_crc16(payload text, seed integer DEFAULT 65535, label text DEFAULT 'a,b'::text)
RETURNS integer LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN length(payload) + seed + length(label);
END;
$$;

CREATE FUNCTION public.list_orders(p_limit integer DEFAULT 20)
RETURNS bigint LANGUAGE sql STABLE AS $$ SELECT count(*) FROM public.orders LIMIT p_limit $$;

CREATE FUNCTION public.touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.order_note() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  prefix text := 'auto';
BEGIN
  NEW.note := prefix || ':' || NEW.code;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.orders_stmt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RETURN NULL;
END;
$$;

CREATE TRIGGER shops_touch BEFORE UPDATE ON public.shops FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER orders_note BEFORE INSERT OR UPDATE ON public.orders FOR EACH ROW
  WHEN (NEW.note IS NULL) EXECUTE FUNCTION public.order_note();
CREATE TRIGGER orders_after AFTER DELETE ON public.orders FOR EACH STATEMENT EXECUTE FUNCTION public.orders_stmt();
`;

// Catalog snapshot: what must survive the round trip. Trigger/function names
// change (AccessNexus prefixes them), so triggers compare by table + timing/events.
const SNAPSHOT_SQL = {
  columns: `
    SELECT c.relname || '.' || a.attname AS col,
           CASE WHEN t.typtype = 'e' THEN 'enum:' || (SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid = t.oid)
                ELSE format_type(a.atttypid, a.atttypmod) END AS type,
           a.attnotnull AS not_null, a.attidentity::text AS identity,
           regexp_replace(coalesce(pg_get_expr(d.adbin, d.adrelid), ''), '::[a-z_.]*status[a-z_]*', '') AS dflt
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'accessnexus_migrations' AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY 1`,
  constraints: `
    SELECT c.relname AS tbl, con.contype::text AS type,
           (SELECT string_agg(a.attname, ',' ORDER BY k.o) FROM unnest(con.conkey) WITH ORDINALITY k(n, o)
              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n) AS cols,
           CASE WHEN con.confrelid = 0 THEN '' ELSE con.confrelid::regclass::text END AS target, con.confdeltype::text AS on_delete
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND con.contype IN ('p', 'f', 'u') AND c.relname <> 'accessnexus_migrations'
    UNION ALL
    -- A UNIQUE constraint may come back as a unique index: same guarantee.
    SELECT c.relname, 'u', (SELECT string_agg(a.attname, ',' ORDER BY k.o) FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(n, o)
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n), '', ' '
    FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND i.indisunique AND NOT i.indisprimary AND c.relname <> 'accessnexus_migrations'
      AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid)
    ORDER BY 1, 2, 3`,
  triggers: `
    SELECT c.relname AS tbl, t.tgtype::int AS tgtype, p.prosecdef AS definer,
           regexp_replace(pg_get_triggerdef(t.oid), '^.* ON public\\.\\w+ |EXECUTE FUNCTION .*$', '', 'g') AS shape
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
    ORDER BY 1, 2, 4`,
  functions: `
    SELECT p.proname AS name, pg_get_function_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS returns
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prorettype <> 'pg_catalog.trigger'::regtype AND p.proname <> 'uuid_generate_v7'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
    ORDER BY 1`,
};

let pg: any;
let admin: any;

async function resetDatabase(): Promise<void> {
  await admin.query(`
    DO $$
    DECLARE r record;
    BEGIN
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.tablename);
      END LOOP;
      FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public'
                 AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e') LOOP
        EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', r.sig);
      END LOOP;
      FOR r IN SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
               WHERE n.nspname = 'public' AND t.typtype = 'e' LOOP
        EXECUTE format('DROP TYPE IF EXISTS public.%I CASCADE', r.typname);
      END LOOP;
    END $$;
    DELETE FROM auth.users WHERE id = '${USER_ID}';
  `);
}

async function snapshot(): Promise<Record<string, any[]>> {
  const out: Record<string, any[]> = {};
  for (const [key, sql] of Object.entries(SNAPSHOT_SQL)) out[key] = (await admin.query(sql)).rows;
  return out;
}

async function cli(...argv: string[]): Promise<{ code: number; json: any; stderr: string }> {
  let stdout = '';
  let stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as any);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as any);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const warnings: string[] = [];
  const onWarning = (w: Error) => warnings.push(w.message);
  process.on('warning', onWarning);
  const code = await runCli([...argv, '--json']);
  await new Promise((r) => setTimeout(r, 20));
  process.off('warning', onWarning);
  vi.restoreAllMocks();
  return { code, json: JSON.parse(stdout), stderr: stderr + warnings.join('\n') };
}

describe.skipIf(!DB_URL)('init --db-url round trip against a real Supabase Postgres', () => {
  let cwd: string;
  let previousCwd: string;

  beforeAll(async () => {
    pg = await import('pg');
    pg = pg.default ?? pg;
    admin = new pg.Client({ connectionString: DB_URL });
    await admin.connect();
    // Integration files share the database and reset it: hold a session lock so
    // vitest's parallel files run one after another.
    await admin.query('SELECT pg_advisory_lock(727274)');
    await resetDatabase();
    previousCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), 'accessnexus-import-'));
    process.chdir(cwd);
  }, 600_000);

  afterAll(async () => {
    process.chdir(previousCwd);
    rmSync(cwd, { recursive: true, force: true });
    await resetDatabase().catch(() => {});
    await admin?.end();
  });

  it('imports triggers, defaults, exact types and keys, and push recreates them', async () => {
    await admin.query(FIXTURE);
    const before = await snapshot();

    const init = await cli('init', '--yes', '--no-agents', '--db-url', DB_URL!);
    expect(init.code).toBe(0);
    // Queries ran one at a time on the pg client (no "already executing a query").
    expect(init.stderr).not.toContain('already executing a query');

    const schemaPath = join(cwd, 'accessnexus.schema.ts');
    const source = readFileSync(schemaPath, 'utf-8');
    expect(source).toContain("total: { type: 'numeric(10,2)', default: '0' },");
    expect(source).toContain(`status: { type: "enum('pending','paid','cancelled')", default: "'pending'" },`);
    expect(source).toContain("created_at: { type: 'timestamptz', default: 'now()' },");
    expect(source).toContain("owner_id: 'auth.users.id',");
    expect(source).toContain("compositePrimaryKey: ['shop_id', 'user_id'],");
    expect(source).toContain("{ columns: ['shop_id', 'code'], unique: true },");
    expect(source).toContain("seed: { type: 'int', default: '65535' }");
    expect(source).toContain("_pix_crc16: rpc({");
    expect(source).toContain("name: 'orders_note',");
    expect(source).toContain("security: 'definer',");
    expect(source).toContain("forEach: 'statement',");

    writeFileSync(schemaPath, source.replace("from 'accessnexus'", `from '${SRC_INDEX}'`));

    const validate = await cli('validate');
    expect(validate.json.issues?.filter((i: any) => i.severity === 'error') ?? []).toEqual([]);
    expect(validate.code).toBe(0);
    expect((await cli('generate')).code).toBe(0);

    // Recreate everything from the generated SQL in an empty public schema.
    await resetDatabase();
    const push = await cli('push', '--url', DB_URL!);
    expect(push.json.error ?? null).toBeNull();
    expect(push.code).toBe(0);

    const after = await snapshot();
    expect(after.columns).toEqual(before.columns);
    expect(after.constraints).toEqual(before.constraints);
    expect(after.triggers).toEqual(before.triggers);
    expect(after.functions).toEqual(before.functions);

    // The imported triggers and RPC defaults behave like the originals.
    await admin.query(`INSERT INTO auth.users (id, email) VALUES ('${USER_ID}', 'import@example.com')`);
    const shop = await admin.query(`INSERT INTO shops (owner_id, name, slug) VALUES ('${USER_ID}', 's', 's') RETURNING id`);
    const order = await admin.query(`INSERT INTO orders (shop_id, code, total) VALUES ('${shop.rows[0].id}', 'A1', 12.345) RETURNING note, total, status`);
    expect(order.rows[0]).toEqual({ note: 'auto:A1', total: '12.35', status: 'pending' });
    await admin.query(`UPDATE shops SET name = 't'`);
    const touched = await admin.query(`SELECT updated_at IS NOT NULL AS ok FROM shops`);
    expect(touched.rows[0].ok).toBe(true);
    const crc = await admin.query(`SELECT _pix_crc16('ab') AS v, list_orders() AS n`);
    expect(crc.rows[0]).toEqual({ v: 2 + 65535 + 3, n: '1' });
  }, 120_000);
});
