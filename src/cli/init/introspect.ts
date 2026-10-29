// ============================================
// AccessNexus - Supabase Database Introspection
// Reads the PostgREST OpenAPI spec exposed at /rest/v1/
// --------------------------------------------
// Hosted Supabase does NOT expose pg-meta on the public project URL, so schema
// introspection goes through PostgREST's OpenAPI document, which every project
// serves at `<url>/rest/v1/`. It describes each exposed table: columns, types
// (in `format`), NOT NULL (in `required`), defaults, and PK/FK hints embedded
// in each column's `description`. RLS policy bodies are not available this way.
// ============================================

export interface IntrospectedColumn {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  ordinal_position: number;
  /** `format_type()` output, e.g. `numeric(10,2)` (direct DB introspection only). */
  formatted_type?: string;
  /** Labels of an enum column, in order (direct DB introspection only). */
  enum_values?: string[];
  /** `attidentity`: 'a' (ALWAYS), 'd' (BY DEFAULT) or '' (direct DB only). */
  identity?: string;
  /** A generated column (`GENERATED ALWAYS AS (...) STORED`); direct DB only. */
  generated?: boolean;
}

/** A user trigger read from pg_trigger (direct DB introspection only). */
export interface IntrospectedTrigger {
  name: string;
  /** pg_trigger.tgtype bit mask (ROW=1, BEFORE=2, INSERT=4, DELETE=8, UPDATE=16, TRUNCATE=32, INSTEAD=64). */
  tgtype: number;
  /** `pg_get_triggerdef()`, the CREATE TRIGGER statement as Postgres would dump it. */
  definition: string;
  /** Number of arguments passed to the function (TG_ARGV). */
  nargs: number;
  /** `UPDATE OF col, ...` columns (empty when none). */
  updateColumns: string[];
  /** Constraint trigger (CREATE CONSTRAINT TRIGGER). */
  isConstraint: boolean;
  /** pg_trigger.tgenabled: 'O' origin (enabled), 'D' disabled, 'R' replica, 'A' always. */
  enabled: string;
  functionName: string;
  functionSchema: string;
  language: string;
  security: 'invoker' | 'definer';
  /** pg_proc.proconfig of the trigger function (`{ name: value }`); direct DB only. */
  config?: Record<string, string>;
  /** pg_proc.prosrc of the trigger function. */
  body: string;
}

export interface IntrospectedPolicy {
  tablename: string;
  policyname: string;
  cmd: string;
  qual: string | null;
  with_check: string | null;
  /** Roles the policy applies to (`TO ...`); `['public']` when absent. */
  roles?: string[];
  /** `'PERMISSIVE'` (OR-ed, the default) or `'RESTRICTIVE'` (AND-ed). */
  permissive?: 'PERMISSIVE' | 'RESTRICTIVE';
}

export interface IntrospectedTable {
  name: string;
  columns: IntrospectedColumn[];
  primaryKey?: string;
  /** Primary key columns when the key spans several columns (direct DB only). */
  compositePrimaryKey?: string[];
  foreignKeys: Array<{
    column: string;
    referencedTable: string;
    referencedColumn: string;
    /** Schema of the referenced table when it is not `public` (e.g. `auth`). */
    referencedSchema?: string;
    /** `ON DELETE` action when it is not the default NO ACTION. */
    onDelete?: 'cascade' | 'set null' | 'restrict';
  }>;
  /** Multi-column foreign keys (not representable per column), as SQL text for a comment. */
  compositeForeignKeys?: string[];
  uniqueColumns: string[];
  /** Multi-column UNIQUE constraints (direct DB only). */
  uniqueGroups?: string[][];
  policies: IntrospectedPolicy[];
  /** User triggers (direct DB only). */
  triggers?: IntrospectedTrigger[];
  /** Whether RLS is enabled on the table (only known with a direct DB connection). */
  rlsEnabled?: boolean;
}

export interface IntrospectionResult {
  tables: IntrospectedTable[];
}

const TIMEOUT_MS = 20_000;

// PostGIS / system tables PostgREST may expose but that should not become schema.
const SYSTEM_TABLES = new Set([
  'spatial_ref_sys',
  'geography_columns',
  'geometry_columns',
  'raster_columns',
  'raster_overviews',
]);

interface OpenApiProperty {
  type?: string;
  format?: string;
  default?: unknown;
  description?: string;
  items?: { type?: string; format?: string };
  enum?: string[];
}
interface OpenApiDefinition {
  required?: string[];
  properties?: Record<string, OpenApiProperty>;
}
interface OpenApiSpec {
  definitions?: Record<string, OpenApiDefinition>;
}

export async function introspectDatabase(
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<IntrospectionResult> {
  const baseUrl = supabaseUrl.replace(/\/$/, '');
  const spec = await fetchOpenApi(baseUrl, serviceRoleKey);
  const defs = spec.definitions ?? {};

  const tables: IntrospectedTable[] = [];

  for (const [name, def] of Object.entries(defs)) {
    if (SYSTEM_TABLES.has(name)) continue;
    const props = def.properties ?? {};
    const required = new Set(def.required ?? []);

    const columns: IntrospectedColumn[] = [];
    const foreignKeys: IntrospectedTable['foreignKeys'] = [];
    let primaryKey: string | undefined;
    let ordinal = 1;

    for (const [column, prop] of Object.entries(props)) {
      const udt = normalizeType(prop);
      columns.push({
        table_name: name,
        column_name: column,
        data_type: udt,
        udt_name: udt,
        is_nullable: required.has(column) ? 'NO' : 'YES',
        column_default: prop.default != null ? String(prop.default) : null,
        ordinal_position: ordinal++,
      });

      const desc = prop.description ?? '';
      if (/<pk\/>/.test(desc)) primaryKey = column;
      const fk = desc.match(/<fk table='([^']+)' column='([^']+)'\/>/);
      if (fk) {
        foreignKeys.push({ column, referencedTable: fk[1], referencedColumn: fk[2] });
      }
    }

    tables.push({
      name,
      columns,
      primaryKey,
      foreignKeys,
      uniqueColumns: [], // not exposed by the OpenAPI spec
      policies: [], // RLS bodies not available via PostgREST; author them in the schema
    });
  }

  // Stable order for deterministic schema output
  tables.sort((a, b) => a.name.localeCompare(b.name));
  return { tables };
}

/** Map an OpenAPI column spec to a udt_name token understood by pg-type-map. */
function normalizeType(prop: OpenApiProperty): string {
  // PostgREST puts the real PG type in `format` (e.g. "timestamp with time zone").
  const raw = (prop.format ?? prop.type ?? 'text').toLowerCase();

  const aliases: Record<string, string> = {
    'timestamp with time zone': 'timestamptz',
    'timestamp without time zone': 'timestamp',
    'time with time zone': 'timetz',
    'time without time zone': 'time',
    'character varying': 'varchar',
    'character': 'char',
    'double precision': 'double precision',
    'bigint': 'int8',
    'integer': 'int4',
    'smallint': 'int2',
  };

  if (aliases[raw]) return aliases[raw];
  // Arrays / user-defined enums are not represented by the scalar map — fall back
  // to text (the map's default). The user refines these in the generated schema.
  if (raw === 'array' || raw === 'user-defined') return 'text';
  return raw;
}

async function fetchOpenApi(baseUrl: string, key: string): Promise<OpenApiSpec> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/rest/v1/`, {
      method: 'GET',
      headers: {
        Accept: 'application/openapi+json, application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Supabase rejected the API key (${response.status}). Introspection needs a ` +
          `service_role / secret key (sb_secret_… or the service_role key), not the anon/publishable key.`,
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Supabase introspection failed (${response.status}): ${body || response.statusText}`);
    }

    return (await response.json()) as OpenApiSpec;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error('Connection to Supabase timed out (20s). Check your URL and network.');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
