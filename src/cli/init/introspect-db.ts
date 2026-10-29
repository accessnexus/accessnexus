// ============================================
// AccessNexus - Full Database Introspection (direct Postgres)
// --------------------------------------------
// Unlike the PostgREST/OpenAPI path (introspect.ts), a direct `pg` connection
// can read EVERYTHING the schema needs: tables, columns, PK/FK/unique, and the
// parts REST cannot expose — RLS policies (pg_policies) and functions (pg_proc).
// Use this whenever a database URL is available; it is the faithful path for
// adopting an existing project with dozens of policies and functions.
//
// `pg` is a peer dependency loaded dynamically (same as push/seed).
// ============================================

import { dbConnectTimeoutMs } from '../db-timeout.js';
import type {
  IntrospectedColumn,
  IntrospectedPolicy,
  IntrospectedTable,
  IntrospectionResult,
} from './introspect.js';

export interface IntrospectedFunction {
  name: string;
  args: string; // pg_get_function_arguments, e.g. "p_id uuid, p_amount numeric"
  returns: string; // pg_get_function_result
  language: string; // plpgsql | sql | ...
  security: 'invoker' | 'definer';
  volatility: 'immutable' | 'stable' | 'volatile';
  body: string; // prosrc (inner body)
}

export interface DbIntrospectionResult extends IntrospectionResult {
  functions: IntrospectedFunction[];
}

// PostGIS / system tables that live in public but should not become schema.
const SYSTEM_TABLES = new Set([
  'spatial_ref_sys',
  'geography_columns',
  'geometry_columns',
  'raster_columns',
  'raster_overviews',
]);

const COLUMNS_SQL = `
SELECT c.table_name, c.column_name, c.udt_name, c.is_nullable,
       c.column_default, c.ordinal_position
FROM information_schema.columns c
JOIN information_schema.tables t
  ON t.table_schema = c.table_schema AND t.table_name = c.table_name
WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
ORDER BY c.table_name, c.ordinal_position;`;

const CONSTRAINTS_SQL = `
SELECT tc.table_name, kcu.column_name, tc.constraint_type,
       ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
LEFT JOIN information_schema.constraint_column_usage ccu
  ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
WHERE tc.table_schema = 'public'
  AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY', 'UNIQUE')
ORDER BY tc.table_name;`;

// roles is name[]; return it as text so every pg version parses it the same.
const POLICIES_SQL = `
SELECT tablename, policyname, cmd, qual, with_check, permissive,
       array_to_string(roles, ',') AS roles
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;`;

const RLS_SQL = `
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p');`;

// User functions only — exclude anything owned by an extension (PostGIS, etc).
const FUNCTIONS_SQL = `
SELECT p.proname AS name,
       pg_get_function_arguments(p.oid) AS args,
       pg_get_function_result(p.oid) AS returns,
       l.lanname AS language,
       p.prosecdef AS secdef,
       p.provolatile AS volatility,
       p.prosrc AS body
FROM pg_proc p
JOIN pg_namespace ns ON ns.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
WHERE ns.nspname = 'public'
  AND p.prokind = 'f'
  -- Trigger / event-trigger handlers are not callable RPCs; exclude them.
  AND p.prorettype NOT IN ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype)
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
ORDER BY p.proname;`;

interface ConstraintRow {
  table_name: string;
  column_name: string;
  constraint_type: 'PRIMARY KEY' | 'FOREIGN KEY' | 'UNIQUE';
  foreign_table_name: string | null;
  foreign_column_name: string | null;
}

export async function introspectViaDb(dbUrl: string): Promise<DbIntrospectionResult> {
  const client = await createPgClient(dbUrl);
  try {
    const [cols, cons, pols, fns, rls] = await Promise.all([
      client.query(COLUMNS_SQL),
      client.query(CONSTRAINTS_SQL),
      client.query(POLICIES_SQL),
      client.query(FUNCTIONS_SQL),
      client.query(RLS_SQL),
    ]);

    const tableMap = new Map<string, IntrospectedTable>();
    const ensure = (name: string): IntrospectedTable => {
      let t = tableMap.get(name);
      if (!t) {
        t = { name, columns: [], foreignKeys: [], uniqueColumns: [], policies: [] };
        tableMap.set(name, t);
      }
      return t;
    };

    for (const row of cols.rows as IntrospectedColumn[]) {
      if (SYSTEM_TABLES.has(row.table_name)) continue;
      ensure(row.table_name).columns.push({
        table_name: row.table_name,
        column_name: row.column_name,
        data_type: row.udt_name,
        udt_name: row.udt_name,
        is_nullable: row.is_nullable,
        column_default: row.column_default,
        ordinal_position: row.ordinal_position,
      });
    }

    for (const con of cons.rows as ConstraintRow[]) {
      const t = tableMap.get(con.table_name);
      if (!t) continue;
      if (con.constraint_type === 'PRIMARY KEY') t.primaryKey = con.column_name;
      else if (con.constraint_type === 'FOREIGN KEY' && con.foreign_table_name && con.foreign_column_name) {
        t.foreignKeys.push({
          column: con.column_name,
          referencedTable: con.foreign_table_name,
          referencedColumn: con.foreign_column_name,
        });
      } else if (con.constraint_type === 'UNIQUE' && !t.uniqueColumns.includes(con.column_name)) {
        t.uniqueColumns.push(con.column_name);
      }
    }

    for (const row of pols.rows as any[]) {
      tableMap.get(row.tablename)?.policies.push({
        tablename: row.tablename,
        policyname: row.policyname,
        cmd: row.cmd,
        qual: row.qual,
        with_check: row.with_check,
        roles: String(row.roles ?? 'public').split(',').map((r) => r.trim()).filter(Boolean),
        permissive: row.permissive === 'RESTRICTIVE' ? 'RESTRICTIVE' : 'PERMISSIVE',
      } satisfies IntrospectedPolicy);
    }

    for (const row of rls.rows as Array<{ table_name: string; rls_enabled: boolean }>) {
      const t = tableMap.get(row.table_name);
      if (t) t.rlsEnabled = Boolean(row.rls_enabled);
    }

    const functions: IntrospectedFunction[] = (fns.rows as any[]).map((r) => ({
      name: r.name,
      args: r.args ?? '',
      returns: r.returns ?? 'void',
      language: r.language ?? 'plpgsql',
      security: r.secdef ? 'definer' : 'invoker',
      volatility: r.volatility === 'i' ? 'immutable' : r.volatility === 's' ? 'stable' : 'volatile',
      body: r.body ?? '',
    }));

    const tables = Array.from(tableMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    return { tables, functions };
  } finally {
    await client.end().catch(() => {});
  }
}

/** Load the `pg` peer dependency dynamically and open a connection. */
async function createPgClient(dbUrl: string): Promise<any> {
  let pg: any;
  try {
    const moduleName = 'pg';
    pg = await import(moduleName);
  } catch (cause) {
    throw new PgDriverMissingError(cause);
  }
  const Client = pg.Client ?? pg.default?.Client;
  const client = new Client({ connectionString: dbUrl, connectionTimeoutMillis: dbConnectTimeoutMs() });
  await client.connect();
  return client;
}

/** The optional `pg` peer dependency is not installed. */
export class PgDriverMissingError extends Error {
  constructor(cause?: unknown) {
    super('the "pg" Postgres driver is not installed', { cause });
    this.name = 'PgDriverMissingError';
  }
}
