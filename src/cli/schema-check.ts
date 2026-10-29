// ============================================
// AccessNexus CLI - Schema checks
// Static checks run by `validate`, `generate`, `diff` and `push` before any SQL
// is produced. Catches the mistakes that would otherwise only surface as a
// Postgres error at push time (or worse, as an open table in production).
// ============================================

import { closest } from './args.js';
import type { SchemaIssue } from './output.js';

const POLICY_OPERATIONS = ['select', 'insert', 'update', 'delete'] as const;

/** Options accepted by table() / Database-mode table configs. */
const TABLE_KEYS = [
  'columns', 'primaryKey', 'compositePrimaryKey', 'references', 'onDelete', 'policies', 'triggers', 'enableRLS', 'indexes', 'softDelete',
] as const;

const SCALAR_TYPES = new Set([
  'uuid', 'text', 'varchar', 'int', 'smallint', 'bigint', 'serial', 'float', 'decimal', 'numeric',
  'boolean', 'json', 'jsonb', 'date', 'timestamp', 'timestamptz', 'time',
  'text[]', 'int[]', 'uuid[]',
]);

const TRIGGER_EVENTS = new Set([
  'before_insert', 'after_insert', 'before_update', 'after_update', 'before_delete', 'after_delete',
]);

// One optional leading underscore (`_pix_crc16`, `_internal`): still a valid
// unquoted Postgres identifier, and common for helper functions.
const IDENTIFIER = /^_?[a-z][a-z0-9_]*$/;

const FK_ACTIONS = new Set(['cascade', 'set null', 'restrict', 'no action']);

/** Bare words that are valid SQL default expressions on their own. */
const DEFAULT_KEYWORDS = new Set([
  'true', 'false', 'null', 'current_timestamp', 'current_date', 'current_time', 'localtime',
  'localtimestamp', 'current_user', 'session_user', 'current_role',
]);

/**
 * Postgres reserved keywords (reserved + "can be function or type name"):
 * not usable as unquoted table/column names. AccessNexus emits identifiers
 * unquoted, so these must be renamed.
 */
const RESERVED_WORDS = new Set([
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric', 'authorization',
  'binary', 'both', 'case', 'cast', 'check', 'collate', 'collation', 'column', 'concurrently',
  'constraint', 'create', 'cross', 'current_catalog', 'current_date', 'current_role',
  'current_schema', 'current_time', 'current_timestamp', 'current_user', 'default', 'deferrable',
  'desc', 'distinct', 'do', 'else', 'end', 'except', 'false', 'fetch', 'for', 'foreign', 'freeze',
  'from', 'full', 'grant', 'group', 'having', 'ilike', 'in', 'initially', 'inner', 'intersect',
  'into', 'is', 'isnull', 'join', 'lateral', 'leading', 'left', 'like', 'limit', 'localtime',
  'localtimestamp', 'natural', 'not', 'notnull', 'null', 'offset', 'on', 'only', 'or', 'order',
  'outer', 'overlaps', 'placing', 'primary', 'references', 'returning', 'right', 'select',
  'session_user', 'similar', 'some', 'symmetric', 'system_user', 'table', 'tablesample', 'then',
  'to', 'trailing', 'true', 'union', 'unique', 'user', 'using', 'variadic', 'verbose', 'when',
  'where', 'window', 'with',
]);

/** Suggest a non-reserved replacement for a reserved identifier. */
function reservedHint(name: string, kind: 'table' | 'column'): string {
  const suggestion = kind === 'table' ? `${name}s` : `${name}_value`;
  const example = name === 'order' ? 'orders' : name === 'user' ? (kind === 'table' ? 'users' : 'user_id') : suggestion;
  return `"${name}" is a reserved SQL keyword. Rename it, e.g. "${example}".`;
}
const PLAIN_COLUMN = /^[a-z_][a-z0-9_]*$/i;

/** Common type names agents reach for, mapped to the AccessNexus spelling. */
const TYPE_SUGGESTIONS: Readonly<Record<string, string>> = {
  string: 'text',
  integer: 'int',
  int4: 'int',
  int8: 'bigint',
  number: 'float',
  numeric: 'decimal',
  bool: 'boolean',
  datetime: 'timestamptz',
  timestamp_with_time_zone: 'timestamptz',
  'timestamp with time zone': 'timestamptz',
  object: 'jsonb',
};

export interface SchemaSummary {
  mode: 'manual' | 'database';
  tables: Array<{
    name: string;
    columns: number;
    primaryKey: string | null;
    rls: boolean;
    policies: string[];
    /** `name` is the trigger's explicit name, or null when the generator derives it. */
    triggers: Array<{ kind: string; name: string | null }>;
  }>;
  rpcs: string[];
}

interface Ctx {
  schema: Record<string, any>;
  manual: boolean;
  issues: SchemaIssue[];
  /** Dedupe keys for issues that would otherwise repeat once per rule. */
  reported: Set<string>;
}

/** Columns declared for a table (empty in Database mode). */
function columnsOf(def: any): Record<string, unknown> {
  return def && typeof def.columns === 'object' && def.columns !== null ? def.columns : {};
}

function hasColumns(def: any): boolean {
  return Object.keys(columnsOf(def)).length > 0;
}

function columnType(input: unknown): string | undefined {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && typeof (input as any).type === 'string') return (input as any).type;
  return undefined;
}

function baseOf(type: string): string {
  return type.endsWith('?') ? type.slice(0, -1) : type;
}

function isValidType(type: string): boolean {
  const base = baseOf(type);
  return SCALAR_TYPES.has(base) || /^enum\(.+\)$/.test(base) || /^numeric\(\d+(,\d+)?\)$/.test(base);
}

/** Values of an `enum('a','b')` column type, or undefined for other types. */
function enumValuesOf(type: string | undefined): string[] | undefined {
  return type === undefined ? undefined : /^enum\((.*)\)$/.exec(baseOf(type))?.[1]
    .split(',')
    .map((v) => v.trim().replace(/^['"]|['"]$/g, ''));
}

/** Describe the schema for `validate` output. */
export function summarizeSchema(schema: Record<string, any>): SchemaSummary {
  const entries = Object.entries(schema);
  const manual = entries.length === 0 || entries.some(([, def]) => hasColumns(def));
  return {
    mode: manual ? 'manual' : 'database',
    tables: entries.map(([name, def]) => ({
      name,
      columns: Object.keys(columnsOf(def)).length,
      primaryKey: typeof def?.primaryKey === 'string' ? def.primaryKey : null,
      rls: def?.enableRLS !== false,
      policies: def?.policies ? POLICY_OPERATIONS.filter((op) => def.policies[op]) : [],
      triggers: Array.isArray(def?.triggers)
        ? def.triggers.map((t: any) => ({ kind: String(t?.kind ?? 'unknown'), name: typeof t?.name === 'string' ? t.name : null }))
        : [],
    })),
    rpcs: Object.keys(((schema as any).__rpcs as Record<string, unknown> | undefined) ?? {}),
  };
}

/**
 * Check a loaded schema and return every problem found (errors first).
 * Errors mean the generated SQL would be wrong or fail to apply; warnings flag
 * risky-but-valid choices (e.g. a table with RLS disabled).
 */
export function checkSchema(schema: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];

  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    issues.push({
      severity: 'error',
      code: 'SCHEMA_NOT_AN_OBJECT',
      path: '(default export)',
      message: 'The schema file must `export default defineSchema({ ... })`',
      hint: 'Wrap your tables in defineSchema() and export it as the default export.',
    });
    return issues;
  }

  const record = schema as Record<string, any>;
  const entries = Object.entries(record);
  if (entries.length === 0) {
    issues.push({
      severity: 'warning',
      code: 'SCHEMA_EMPTY',
      path: '(schema)',
      message: 'The schema defines no tables',
      hint: 'Add tables with table({ columns, primaryKey, policies }).',
    });
    return issues;
  }

  const ctx: Ctx = {
    schema: record,
    manual: entries.some(([, def]) => hasColumns(def)),
    issues,
    reported: new Set(),
  };

  for (const [tableName, def] of entries) {
    checkTable(ctx, tableName, def);
  }

  const rpcs = (record as any).__rpcs as Record<string, any> | undefined;
  for (const [name, def] of Object.entries(rpcs ?? {})) {
    checkRpc(ctx, name, def);
  }

  return issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}

function push(ctx: Ctx, issue: SchemaIssue): void {
  ctx.issues.push(issue);
}

function unknownColumn(ctx: Ctx, path: string, table: string, column: string, what: string): void {
  const available = Object.keys(columnsOf(ctx.schema[table]));
  push(ctx, {
    severity: 'error',
    code: 'UNKNOWN_COLUMN',
    path,
    message: `${what} "${column}" is not a column of "${table}"`,
    hint: available.length > 0
      ? `Use one of: ${available.join(', ')} — or add "${column}" to ${table}.columns.`
      : `Add "${column}" to ${table}.columns.`,
  });
}

/**
 * Unknown table options are ignored by the generator, so a typo such as
 * `polices:` silently drops the rules (deny-all). The CLI loads schemas with
 * esbuild, which strips types, so tsc never sees the mistake: report it here.
 */
function checkTableKeys(ctx: Ctx, tableName: string, def: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(def)) {
    if ((TABLE_KEYS as readonly string[]).includes(key)) continue;
    // defineSchema({ tables: { notes: table(...) } }) makes "tables" a table whose keys are tables
    const looksLikeTable = !!value && typeof value === 'object' && ('columns' in value || 'policies' in value);
    const suggestion = closest(key, TABLE_KEYS);
    push(ctx, {
      severity: 'error',
      code: 'UNKNOWN_TABLE_KEY',
      path: `${tableName}.${key}`,
      message: `Unknown option "${key}" in table "${tableName}"; it would be ignored`,
      hint: looksLikeTable
        ? `Tables go directly in defineSchema: defineSchema({ ${key}: table({ ... }) }), not inside "${tableName}".`
        : suggestion
          ? `Did you mean "${suggestion}"? Table options: ${TABLE_KEYS.join(', ')}.`
          : `Table options: ${TABLE_KEYS.join(', ')}.`,
    });
  }
}

function checkTable(ctx: Ctx, tableName: string, def: any): void {
  const path = tableName;

  if (!def || typeof def !== 'object') {
    push(ctx, {
      severity: 'error',
      code: 'INVALID_TABLE',
      path,
      message: `Table "${tableName}" must be an object created with table({ ... })`,
      hint: `Write ${tableName}: table({ columns: { ... }, primaryKey: 'id', policies: { ... } }).`,
    });
    return;
  }

  if (def._rpc === true) {
    push(ctx, {
      severity: 'error',
      code: 'RPC_IN_TABLES',
      path,
      message: `"${tableName}" is an rpc() but was placed among the tables`,
      hint: `Pass RPCs in the second argument: defineSchema({ ...tables }, { rpcs: { ${tableName}: rpc({...}) } }).`,
    });
    return;
  }

  checkTableKeys(ctx, tableName, def);

  if (!IDENTIFIER.test(tableName)) {
    push(ctx, {
      severity: 'error',
      code: 'INVALID_IDENTIFIER',
      path,
      message: `Table name "${tableName}" is not lowercase snake_case`,
      hint: 'Rename it, e.g. "user_profiles".',
    });
  } else if (RESERVED_WORDS.has(tableName)) {
    push(ctx, {
      severity: 'error',
      code: 'RESERVED_IDENTIFIER',
      path,
      message: `Table name "${tableName}" is a reserved SQL keyword; the generated SQL would not parse`,
      hint: reservedHint(tableName, 'table'),
    });
  }

  const columns = columnsOf(def);
  const tableHasColumns = Object.keys(columns).length > 0;

  if (ctx.manual && !tableHasColumns) {
    push(ctx, {
      severity: 'error',
      code: 'MISSING_COLUMNS',
      path: `${path}.columns`,
      message: `Table "${tableName}" has no columns, but other tables do (manual mode)`,
      hint: 'Either declare columns on every table (manual mode) or on none (Database mode, columns come from your Supabase Database type).',
    });
  }

  for (const [columnName, input] of Object.entries(columns)) {
    const colPath = `${path}.columns.${columnName}`;
    if (!IDENTIFIER.test(columnName)) {
      push(ctx, {
        severity: 'error',
        code: 'INVALID_IDENTIFIER',
        path: colPath,
        message: `Column name "${columnName}" is not lowercase snake_case`,
        hint: 'Rename it, e.g. "created_at".',
      });
    } else if (RESERVED_WORDS.has(columnName)) {
      push(ctx, {
        severity: 'error',
        code: 'RESERVED_IDENTIFIER',
        path: colPath,
        message: `Column name "${columnName}" is a reserved SQL keyword; the generated SQL would not parse`,
        hint: reservedHint(columnName, 'column'),
      });
    }
    const type = columnType(input);
    if (!type) {
      push(ctx, {
        severity: 'error',
        code: 'INVALID_COLUMN',
        path: colPath,
        message: `Column "${columnName}" must be a type string ('text') or { type: 'text', ... }`,
        hint: "Example: email: 'text' or email: { type: 'text', unique: true }.",
      });
      continue;
    }
    if (input && typeof input === 'object') {
      checkColumnDefault(ctx, colPath, columnName, type, (input as any).default);
      checkColumnOnDelete(ctx, colPath, type, (input as any).onDelete, Boolean((input as any).references ?? def.references?.[columnName]));
    }
    if (!isValidType(type)) {
      const suggestion = TYPE_SUGGESTIONS[baseOf(type).toLowerCase()];
      push(ctx, {
        severity: 'error',
        code: 'UNKNOWN_COLUMN_TYPE',
        path: colPath,
        message: `Unknown column type "${type}"`,
        hint: suggestion
          ? `Use '${suggestion}${type.endsWith('?') ? '?' : ''}'.`
          : `Use one of: ${[...SCALAR_TYPES].join(', ')}, "enum('a','b')"; append '?' for nullable.`,
      });
    }
  }

  // Primary key
  if (tableHasColumns) {
    if (def.compositePrimaryKey !== undefined) {
      const composite = def.compositePrimaryKey;
      if (def.primaryKey !== undefined || !Array.isArray(composite) || composite.length < 2) {
        push(ctx, {
          severity: 'error',
          code: 'INVALID_PRIMARY_KEY',
          path: `${path}.compositePrimaryKey`,
          message: def.primaryKey !== undefined
            ? `Table "${tableName}" sets both primaryKey and compositePrimaryKey`
            : `compositePrimaryKey of "${tableName}" must list at least two columns`,
          hint: "Use primaryKey: 'id' for a single column, or compositePrimaryKey: ['a', 'b'] (not both).",
        });
      }
      for (const column of Array.isArray(composite) ? composite : []) {
        if (!(column in columns)) unknownColumn(ctx, `${path}.compositePrimaryKey`, tableName, String(column), 'compositePrimaryKey');
      }
      if (def.softDelete !== undefined) {
        push(ctx, {
          severity: 'error',
          code: 'INVALID_PRIMARY_KEY',
          path: `${path}.softDelete`,
          message: `softDelete on "${tableName}" needs a single-column primaryKey (the soft-delete trigger updates the row by its key)`,
          hint: 'Add a single id primary key, or drop softDelete on this table.',
        });
      }
    } else if (def.primaryKey === undefined) {
      push(ctx, {
        severity: 'warning',
        code: 'NO_PRIMARY_KEY',
        path: `${path}.primaryKey`,
        message: `Table "${tableName}" has no primaryKey`,
        hint: "Add primaryKey: 'id' (findById, update/delete by id and soft delete need it).",
      });
    } else if (!(def.primaryKey in columns)) {
      unknownColumn(ctx, `${path}.primaryKey`, tableName, String(def.primaryKey), 'primaryKey');
    }
  }

  // References
  for (const [column, ref] of Object.entries((def.references ?? {}) as Record<string, unknown>)) {
    if (!ref) continue;
    const refPath = `${path}.references.${column}`;
    if (tableHasColumns && !(column in columns)) {
      unknownColumn(ctx, refPath, tableName, column, 'Reference column');
    }
    const parts = String(ref).split('.');
    if (parts.length < 2 || parts.length > 3) {
      push(ctx, {
        severity: 'error',
        code: 'INVALID_REFERENCE',
        path: refPath,
        message: `Reference "${String(ref)}" must be "table.column" or "schema.table.column"`,
        hint: "Example: author_id: 'profiles.id' or id: 'auth.users.id'.",
      });
      continue;
    }
    if (parts.length === 3) continue; // external schema (auth.users.id) — not ours to check
    const [refTable, refColumn] = parts;
    if (!(refTable in ctx.schema)) {
      push(ctx, {
        severity: ctx.manual ? 'error' : 'warning',
        code: 'UNKNOWN_TABLE',
        path: refPath,
        message: `Reference "${String(ref)}" points to table "${refTable}", which is not in the schema`,
        hint: `Define "${refTable}" in defineSchema, fix the spelling, or use "schema.table.column" for tables outside public.`,
      });
    } else if (hasColumns(ctx.schema[refTable]) && !(refColumn in columnsOf(ctx.schema[refTable]))) {
      unknownColumn(ctx, refPath, refTable, refColumn, 'Referenced column');
    }
  }

  // Table-level onDelete map
  for (const [column, action] of Object.entries((def.onDelete ?? {}) as Record<string, unknown>)) {
    const onDeletePath = `${path}.onDelete.${column}`;
    if (tableHasColumns && !(column in columns)) {
      unknownColumn(ctx, onDeletePath, tableName, column, 'onDelete column');
      continue;
    }
    const columnRef = columns[column] && typeof columns[column] === 'object' ? (columns[column] as any).references : undefined;
    checkColumnOnDelete(ctx, onDeletePath, columnType(columns[column]) ?? '', action, Boolean(columnRef ?? def.references?.[column]));
  }

  // A cascaded DELETE into a soft-delete table is turned into an UPDATE by the
  // soft-delete trigger, so the parent disappears and the child keeps pointing
  // at it (Postgres does not complain).
  const softDeletes = def.softDelete !== undefined
    || (Array.isArray(def.triggers) && def.triggers.some((t: any) => t?.kind === 'soft_delete'));
  if (softDeletes) {
    const cascading = new Set<string>();
    for (const [column, input] of Object.entries(columns)) {
      if (input && typeof input === 'object' && (input as any).onDelete === 'cascade') cascading.add(column);
    }
    for (const [column, action] of Object.entries((def.onDelete ?? {}) as Record<string, unknown>)) {
      if (action === 'cascade') cascading.add(column);
    }
    for (const column of cascading) {
      push(ctx, {
        severity: 'error',
        code: 'CASCADE_INTO_SOFT_DELETE',
        path: `${path}.onDelete.${column}`,
        message: `"${tableName}" uses soft delete, so ON DELETE CASCADE on ${column} would keep its rows pointing at a deleted parent`,
        hint: "Use onDelete: 'restrict' (soft-delete the children first) or 'set null' on a nullable column, or drop softDelete on this table.",
      });
    }
  }

  // Policies / RLS
  if (def.enableRLS === false) {
    push(ctx, {
      severity: def.policies ? 'error' : 'warning',
      code: def.policies ? 'RLS_DISABLED_WITH_POLICIES' : 'RLS_DISABLED',
      path: `${path}.enableRLS`,
      message: def.policies
        ? `Table "${tableName}" sets enableRLS: false but declares policies — policies only work with RLS on`
        : `Table "${tableName}" sets enableRLS: false, so RLS is not enabled — anyone with your anon key can read and write it`,
      hint: def.policies
        ? 'Remove enableRLS: false (RLS is on whenever policies exist).'
        : 'Remove enableRLS: false and add policies (or leave policies out: the table is then deny-all, service role only).',
    });
  }
  if (def.policies === undefined || def.policies === null) {
    if (def.enableRLS !== false) {
      push(ctx, {
        severity: 'warning',
        code: 'NO_POLICIES',
        path: `${path}.policies`,
        message: `Table "${tableName}" has no policies: RLS is on, so anon and signed-in users can neither read nor write it (service role only)`,
        hint: 'Add policies for select/insert/update/delete if the app should use this table from the client; '
          + 'keep it as is for server-only tables (or use policy.none() per operation to make that explicit).',
      });
    }
  } else if (typeof def.policies !== 'object') {
    push(ctx, {
      severity: 'error',
      code: 'INVALID_POLICIES',
      path: `${path}.policies`,
      message: 'policies must be an object like { select: policy.isAuthenticated() }',
      hint: 'Use one key per operation: select, insert, update, delete.',
    });
  } else {
    for (const [op, rule] of Object.entries(def.policies as Record<string, unknown>)) {
      const opPath = `${path}.policies.${op}`;
      if (!(POLICY_OPERATIONS as readonly string[]).includes(op)) {
        const mapped: Record<string, string> = { read: 'select', create: 'insert', write: 'update', all: 'select/insert/update/delete' };
        push(ctx, {
          severity: 'error',
          code: 'UNKNOWN_POLICY_OPERATION',
          path: opPath,
          message: `"${op}" is not a policy operation`,
          hint: mapped[op]
            ? `Use "${mapped[op]}" (read/create/update/delete are only used inside definePermissions resources).`
            : 'Valid keys: select, insert, update, delete.',
        });
        continue;
      }
      if (rule === undefined) continue;
      checkRule(ctx, tableName, opPath, rule);
    }
    checkGlobalRoleInTenantTable(ctx, tableName, def.policies as Record<string, unknown>);
    checkPublicWrites(ctx, tableName, def.policies as Record<string, unknown>);
    checkUserRowInsert(ctx, tableName, def);
    checkTenantParents(ctx, tableName, def);
  }

  // Soft delete
  if (def.softDelete !== undefined && tableHasColumns && !(def.softDelete in columns)) {
    unknownColumn(ctx, `${path}.softDelete`, tableName, String(def.softDelete), 'softDelete column');
  }

  // Triggers
  if (def.triggers !== undefined) {
    if (!Array.isArray(def.triggers)) {
      push(ctx, {
        severity: 'error',
        code: 'INVALID_TRIGGERS',
        path: `${path}.triggers`,
        message: 'triggers must be an array, e.g. [trigger.updatedAt(\'updated_at\')]',
      });
    } else {
      def.triggers.forEach((t: any, index: number) => checkTrigger(ctx, tableName, `${path}.triggers[${index}]`, t));
      checkDuplicateTriggers(ctx, tableName, def.triggers);
    }
  }

  // Indexes
  if (Array.isArray(def.indexes) && tableHasColumns) {
    def.indexes.forEach((index: any, i: number) => {
      for (const column of Array.isArray(index?.columns) ? index.columns : []) {
        if (!(column in columns)) unknownColumn(ctx, `${path}.indexes[${i}]`, tableName, String(column), 'Index column');
      }
    });
  }
}

/**
 * `default` is emitted verbatim as SQL. A bare word such as `default: 'todo'`
 * becomes `DEFAULT todo`, which Postgres reads as a column name and rejects at
 * push time — catch it here.
 */
function checkColumnDefault(ctx: Ctx, path: string, columnName: string, type: string, value: unknown): void {
  if (value === undefined || typeof value !== 'string') return;
  const expr = value.trim();
  const enumValues = /^enum\((.*)\)$/.exec(baseOf(type))?.[1]
    .split(',')
    .map((v) => v.trim().replace(/^['"]|['"]$/g, ''));

  if (enumValues) {
    const quoted = /^'((?:[^']|'')*)'(?:::[\w.]+)?$/.exec(expr);
    if (quoted && enumValues.includes(quoted[1].replaceAll("''", "'"))) return;
    if (quoted || enumValues.includes(expr)) {
      push(ctx, {
        severity: 'error',
        code: 'INVALID_DEFAULT',
        path: `${path}.default`,
        message: quoted
          ? `Default ${expr} for "${columnName}" is not one of its enum values (${enumValues.join(', ')})`
          : `Default "${expr}" for "${columnName}" is a bare word; Postgres would read it as a column name`,
        hint: `default is raw SQL: quote the enum value inside the string, e.g. default: "'${enumValues.includes(expr) ? expr : enumValues[0]}'".`,
      });
      return;
    }
  }

  if (/^[a-z_][a-z0-9_]*$/i.test(expr) && !DEFAULT_KEYWORDS.has(expr.toLowerCase())) {
    push(ctx, {
      severity: 'error',
      code: 'INVALID_DEFAULT',
      path: `${path}.default`,
      message: `Default "${expr}" for "${columnName}" is a bare word; Postgres would read it as a column name`,
      hint: `default is raw SQL: write a string literal with inner quotes (default: "'${expr}'") or a function call (default: 'now()').`,
    });
  }
}

/** `onDelete` needs a foreign key, a known action, and `set null` a nullable column. */
function checkColumnOnDelete(ctx: Ctx, path: string, type: string, action: unknown, hasReference: boolean): void {
  if (action === undefined) return;
  if (typeof action !== 'string' || !FK_ACTIONS.has(action)) {
    push(ctx, {
      severity: 'error',
      code: 'INVALID_ON_DELETE',
      path,
      message: `onDelete must be one of ${[...FK_ACTIONS].map((a) => `'${a}'`).join(', ')}, got ${JSON.stringify(action)}`,
    });
    return;
  }
  if (!hasReference) {
    push(ctx, {
      severity: 'error',
      code: 'INVALID_ON_DELETE',
      path,
      message: 'onDelete is set on a column that has no foreign key (`references`)',
      hint: "Add references: 'table.column' to the column (or the table's references map), or remove onDelete.",
    });
    return;
  }
  if (action === 'set null' && type && !type.endsWith('?')) {
    push(ctx, {
      severity: 'error',
      code: 'INVALID_ON_DELETE',
      path,
      message: "onDelete: 'set null' needs a nullable column, but the column is NOT NULL",
      hint: `Make the column nullable ('${type}?') or use onDelete: 'cascade'.`,
    });
  }
}

const RULE_KINDS = new Set([
  'authenticated', 'public', 'none', 'owner', 'role', 'belongs_to', 'matches_field',
  'custom', 'any', 'all', 'with_check',
]);

function checkRule(ctx: Ctx, tableName: string, path: string, rule: any): void {
  if (!rule || typeof rule !== 'object' || typeof rule.kind !== 'string') {
    push(ctx, {
      severity: 'error',
      code: 'INVALID_POLICY_RULE',
      path,
      message: `Policy must be built with policy.*(), got ${JSON.stringify(rule)}`,
      hint: "Example: select: policy.public() — not select: 'public'.",
    });
    return;
  }

  if (!RULE_KINDS.has(rule.kind)) {
    push(ctx, {
      severity: 'error',
      code: 'UNKNOWN_POLICY_KIND',
      path,
      message: `Unknown policy kind "${rule.kind}"`,
      hint: 'Build rules with the policy.* helpers.',
    });
    return;
  }

  const def = ctx.schema[tableName];
  const tableHasColumns = hasColumns(def);
  const columns = columnsOf(def);

  switch (rule.kind) {
    case 'owner': {
      if (!tableHasColumns) break;
      if (!(rule.column in columns)) {
        unknownColumn(ctx, path, tableName, String(rule.column), 'policy.isOwner column');
        break;
      }
      const type = columnType(columns[rule.column]);
      if (type && baseOf(type) !== 'uuid') {
        push(ctx, {
          severity: 'error',
          code: 'OWNER_COLUMN_NOT_UUID',
          path,
          message: `policy.isOwner('${rule.column}') compares it to auth.uid() (uuid), but the column is '${type}'`,
          hint: `Make ${tableName}.${rule.column} a 'uuid' column (usually referencing auth.users.id or profiles.id).`,
        });
      }
      break;
    }
    case 'role':
      if (typeof rule.role !== 'string' || rule.role.length === 0) {
        push(ctx, { severity: 'error', code: 'INVALID_POLICY_RULE', path, message: 'policy.hasRole() needs a role name' });
      }
      break;
    case 'belongs_to':
      checkBelongsTo(ctx, tableName, path, rule);
      break;
    case 'matches_field':
      for (const field of [rule.fieldA, rule.fieldB]) {
        if (typeof field !== 'string') continue;
        if (tableHasColumns && PLAIN_COLUMN.test(field) && !(field in columns)) {
          unknownColumn(ctx, path, tableName, field, 'policy.matchesField column');
        }
      }
      break;
    case 'custom':
      checkCustomExpression(ctx, path, rule.expression);
      break;
    case 'any':
    case 'all':
      if (!Array.isArray(rule.rules) || rule.rules.length === 0) {
        push(ctx, {
          severity: 'error',
          code: 'EMPTY_COMBINATOR',
          path,
          message: `policy.${rule.kind}([]) needs at least one rule`,
          hint: 'Pass one or more policy.* rules, or use policy.none() to block access.',
        });
        break;
      }
      rule.rules.forEach((sub: unknown, i: number) => checkRule(ctx, tableName, `${path}.${rule.kind}[${i}]`, sub));
      break;
    case 'with_check':
      checkRule(ctx, tableName, `${path}.using`, rule.using);
      checkRule(ctx, tableName, `${path}.check`, rule.check);
      break;
    default:
      break;
  }
}

function ruleKinds(rule: any, out: Set<string> = new Set()): Set<string> {
  if (!rule || typeof rule !== 'object') return out;
  out.add(rule.kind);
  if (Array.isArray(rule.rules)) for (const sub of rule.rules) ruleKinds(sub, out);
  if (rule.kind === 'with_check') {
    ruleKinds(rule.using, out);
    ruleKinds(rule.check, out);
  }
  return out;
}

/**
 * hasRole / definePermissions role arrays check the GLOBAL app role
 * (app_metadata.role). Mixed with tenant membership checks on the same table,
 * that is almost always meant to be a role inside the tenant.
 */
function checkGlobalRoleInTenantTable(ctx: Ctx, tableName: string, policies: Record<string, unknown>): void {
  const kinds = new Set<string>();
  for (const rule of Object.values(policies)) ruleKinds(rule, kinds);
  if (!kinds.has('role') || !kinds.has('belongs_to')) return;
  const ops = Object.entries(policies).filter(([, rule]) => ruleKinds(rule).has('role')).map(([op]) => op);
  push(ctx, {
    severity: 'warning',
    code: 'GLOBAL_ROLE_IN_TENANT_TABLE',
    path: `${tableName}.policies.${ops[0]}`,
    message: `"${tableName}" checks tenant membership, but ${ops.join('/')} uses a global app role (policy.hasRole / a role array in definePermissions), `
      + 'which reads the JWT app_metadata.role — not the role a user has inside the org/team',
    hint: "For org/team roles use { scope: 'tenant', roles: ['admin'] } in definePermissions (or policy.belongsTo(..., { where: { role: ['admin'] } })). "
      + 'Keep the global role only for platform-wide staff set via app_metadata.',
  });
}

/** Same rule the generator uses to grant a write policy `TO public`. */
function anonCanWrite(rule: any): boolean {
  if (!rule || typeof rule !== 'object') return false;
  switch (rule.kind) {
    case 'public':
      return true;
    case 'any':
      return Array.isArray(rule.rules) && rule.rules.some(anonCanWrite);
    case 'all':
      return Array.isArray(rule.rules) && rule.rules.some(anonCanWrite) && rule.rules.every(anonCanPass);
    case 'with_check':
      return anonCanWrite(rule.using) && anonCanPass(rule.check);
    default:
      return false;
  }
}

/** Can the rule be true without a signed-in user? (custom SQL: assume yes) */
function anonCanPass(rule: any): boolean {
  if (!rule || typeof rule !== 'object') return false;
  switch (rule.kind) {
    case 'public':
    case 'custom':
      return true;
    case 'matches_field':
      return !/\bauth\./i.test(String(rule.fieldA)) && !/\bauth\./i.test(String(rule.fieldB));
    case 'any':
      return Array.isArray(rule.rules) && rule.rules.some(anonCanPass);
    case 'all':
      return Array.isArray(rule.rules) && rule.rules.every(anonCanPass);
    case 'with_check':
      return anonCanPass(rule.using);
    default:
      return false;
  }
}

/** policy.public() on insert/update/delete lets anyone with the anon key write. */
function checkPublicWrites(ctx: Ctx, tableName: string, policies: Record<string, unknown>): void {
  for (const op of ['insert', 'update', 'delete'] as const) {
    if (!anonCanWrite(policies[op])) continue;
    push(ctx, {
      severity: 'warning',
      code: 'PUBLIC_WRITE',
      path: `${tableName}.policies.${op}`,
      message: `Anyone, including anonymous visitors with your public anon key, can ${op} rows of "${tableName}" (policy.public())`,
      hint: op === 'insert'
        ? 'Use policy.isAuthenticated() or policy.isOwner(col) — or keep policy.public() only for a deliberate anonymous form, '
          + 'combined with a check, e.g. policy.all([policy.public(), policy.custom(\'length(body) < 2000\')]).'
        : `Restrict ${op} (policy.isOwner(col), a tenant role, or policy.none() for server-only changes).`,
    });
  }
}

/**
 * A table keyed by the auth user id (profiles.id → auth.users.id) must only let
 * a user insert THEIR row; isAuthenticated() lets anyone create other users'
 * rows (impersonation, squatting a unique email).
 */
function checkUserRowInsert(ctx: Ctx, tableName: string, def: any): void {
  const pk = def.primaryKey;
  if (typeof pk !== 'string') return;
  const pkInput = columnsOf(def)[pk];
  const ref = (pkInput && typeof pkInput === 'object' ? (pkInput as any).references : undefined) ?? def.references?.[pk];
  if (ref !== 'auth.users.id') return;
  const insert = def.policies?.insert;
  if (!insert || (insert.kind !== 'authenticated' && insert.kind !== 'public')) return;
  push(ctx, {
    severity: 'warning',
    code: 'USER_ROW_INSERT_OPEN',
    path: `${tableName}.policies.insert`,
    message: `"${tableName}.${pk}" is the auth user id, but any ${insert.kind === 'public' ? 'visitor' : 'signed-in user'} may insert — `
      + 'they can create the row of another user (impersonation)',
    hint: `Use insert: policy.isOwner('${pk}') so each user can only create their own row.`,
  });
}

/** Columns of every belongsTo rule in a table's policies (its tenant columns). */
function tenantColumnsOf(def: any): Set<string> {
  const out = new Set<string>();
  const visit = (rule: any): void => {
    if (!rule || typeof rule !== 'object') return;
    if (rule.kind === 'belongs_to' && typeof rule.column === 'string') out.add(rule.column);
    if (Array.isArray(rule.rules)) rule.rules.forEach(visit);
    if (rule.kind === 'with_check') {
      visit(rule.using);
      visit(rule.check);
    }
  };
  for (const rule of Object.values((def?.policies ?? {}) as Record<string, unknown>)) visit(rule);
  return out;
}

/** column → referenced "table.column" (table map and per-column `references`). */
function referencesOf(def: any): Array<[string, string]> {
  const refs = new Map<string, string>();
  for (const [column, ref] of Object.entries((def.references ?? {}) as Record<string, unknown>)) {
    if (typeof ref === 'string') refs.set(column, ref);
  }
  for (const [column, input] of Object.entries(columnsOf(def))) {
    const ref = input && typeof input === 'object' ? (input as any).references : undefined;
    if (typeof ref === 'string') refs.set(column, ref);
  }
  return [...refs];
}

/**
 * A tenant-scoped row (tasks.org_id) pointing at another tenant-scoped row
 * (tasks.project_id → projects, scoped by projects.org_id): RLS only checks the
 * row's own tenant column and foreign keys ignore RLS, so without a guard a
 * member of org A can attach rows to org B's projects.
 */
function checkTenantParents(ctx: Ctx, tableName: string, def: any): void {
  const ownTenant = tenantColumnsOf(def);
  if (ownTenant.size === 0) return;
  const triggers = Array.isArray(def.triggers) ? def.triggers : [];
  for (const [column, ref] of referencesOf(def)) {
    if (ownTenant.has(column)) continue; // the tenant reference itself
    const parts = ref.split('.');
    if (parts.length !== 2) continue;
    const [parentName] = parts;
    if (parentName === tableName) continue;
    const parentTenant = [...tenantColumnsOf(ctx.schema[parentName])].filter((c) => c !== 'id');
    if (parentTenant.length === 0) continue;
    const mentions = new RegExp(`\\b${parentName}\\b`, 'i');
    const guarded = triggers.some((t: any) => t?.kind === 'custom'
      && mentions.test(`${t.functionBody ?? ''} ${t.when ?? ''}`));
    if (guarded) continue;
    const own = [...ownTenant][0];
    const theirs = parentTenant[0];
    push(ctx, {
      severity: 'warning',
      code: 'TENANT_PARENT_UNCHECKED',
      path: `${tableName}.references.${column}`,
      message: `"${tableName}.${column}" points to "${parentName}", which is tenant-scoped (${theirs}), but nothing checks that `
        + `the ${parentName} row is in the same tenant as the ${tableName} row (${own}) — foreign keys ignore RLS, so a member of one `
        + `tenant can attach ${tableName} rows to another tenant's ${parentName}`,
      hint: `Add trigger.custom({ name: 'same_tenant_${parentName}', events: ['before_insert', 'before_update'], functionBody: `
        + `"IF NOT EXISTS (SELECT 1 FROM public.${parentName} p WHERE p.id = NEW.${column} AND p.${theirs} = NEW.${own}) THEN `
        + `RAISE EXCEPTION 'not found' USING ERRCODE = '23503'; END IF; RETURN NEW;" }) and `
        + `trigger.lockColumns({ columns: ['${own}', '${column}'] }) (see the "Child of a tenant resource" recipe in llms.txt).`,
    });
  }
}

function checkBelongsTo(ctx: Ctx, tableName: string, path: string, rule: any): void {
  const def = ctx.schema[tableName];
  if (hasColumns(def) && !(rule.column in columnsOf(def))) {
    unknownColumn(ctx, path, tableName, String(rule.column), 'policy.belongsTo column');
  }

  const through = rule.through;
  if (!through) {
    // Without `through`, the generator checks `profiles.<column>` for the current user.
    const profiles = ctx.schema.profiles;
    if (!profiles) {
      push(ctx, {
        severity: ctx.manual ? 'error' : 'warning',
        code: 'UNKNOWN_TABLE',
        path,
        message: `policy.belongsTo('${rule.column}') without "through" looks up profiles.${rule.column}, but there is no "profiles" table`,
        hint: "Pass the membership table: policy.belongsTo('org_id', { table: 'org_members', foreignKey: 'org_id', localKey: 'user_id' }).",
      });
    } else if (hasColumns(profiles) && !(rule.column in columnsOf(profiles))) {
      unknownColumn(ctx, path, 'profiles', String(rule.column), 'policy.belongsTo (default lookup) column');
    } else {
      checkProfileColumnWritable(ctx, path, String(rule.column), profiles);
    }
    return;
  }

  const joinTable = ctx.schema[through.table];
  if (!joinTable) {
    push(ctx, {
      severity: ctx.manual ? 'error' : 'warning',
      code: 'UNKNOWN_TABLE',
      path,
      message: `policy.belongsTo through table "${through.table}" is not in the schema`,
      hint: `Define "${through.table}" in defineSchema or fix the spelling. Existing tables: ${Object.keys(ctx.schema).join(', ')}.`,
    });
    return;
  }
  if (!hasColumns(joinTable)) return;

  const joinColumns = columnsOf(joinTable);
  for (const [key, column] of [['foreignKey', through.foreignKey], ['localKey', through.localKey]] as const) {
    if (!(column in joinColumns)) {
      unknownColumn(ctx, path, through.table, String(column), `policy.belongsTo through.${key}`);
    }
  }
  for (const [column, expected] of Object.entries(through.where ?? {})) {
    if (!(column in joinColumns)) {
      unknownColumn(ctx, path, through.table, column, 'policy.belongsTo through.where column');
      continue;
    }
    // A typo in a role list would compile to a rule that never matches
    const allowed = enumValuesOf(columnType(joinColumns[column]));
    if (!allowed) continue;
    for (const value of Array.isArray(expected) ? expected : [expected]) {
      if (allowed.includes(String(value))) continue;
      const suggestion = closest(String(value), allowed);
      push(ctx, {
        severity: 'error',
        code: 'INVALID_ENUM_VALUE',
        path,
        message: `policy.belongsTo through.where ${column} "${String(value)}" is not a value of ${through.table}.${column}`,
        hint: `${suggestion ? `Did you mean "${suggestion}"? ` : ''}Allowed values: ${allowed.join(', ')}.`,
      });
    }
  }
}

/** Does trigger.lockColumns on the table freeze `column` for API users on UPDATE? */
function isColumnLocked(def: any, column: string): boolean {
  const triggers = Array.isArray(def?.triggers) ? def.triggers : [];
  return triggers.some((t: any) => t?.kind === 'lock_columns' && (
    (Array.isArray(t.columns) && t.columns.includes(column))
    || (Array.isArray(t.except) && !t.except.includes(column))
  ));
}

/** A policy slot a signed-in user can use (anything but missing / policy.none()). */
function opAllowsUsers(rule: any): boolean {
  return Boolean(rule) && typeof rule === 'object' && rule.kind !== 'none';
}

/**
 * belongsTo(column) without `through` trusts profiles.<column> of the current
 * user (inside a SECURITY DEFINER helper). If users can write that column on
 * their own profile, they can put any tenant id there and join that tenant.
 */
function checkProfileColumnWritable(ctx: Ctx, path: string, column: string, profiles: any): void {
  const key = `BELONGS_TO_PROFILE_WRITABLE:${column}`;
  if (ctx.reported.has(key)) return;

  const rlsOff = profiles.enableRLS === false;
  const policies = (profiles.policies ?? {}) as Record<string, unknown>;
  const insertOpen = rlsOff || opAllowsUsers(policies.insert);
  const updateOpen = rlsOff || (opAllowsUsers(policies.update) && !isColumnLocked(profiles, column));
  if (!insertOpen && !updateOpen) return;

  ctx.reported.add(key);
  const how = rlsOff
    ? 'profiles has RLS turned off (enableRLS: false)'
    : [insertOpen ? 'profiles.policies.insert lets users create their profile row' : '',
      updateOpen ? `profiles.policies.update lets users change their row and no trigger.lockColumns covers "${column}"` : '']
      .filter(Boolean).join(' and ');
  push(ctx, {
    severity: 'error',
    code: 'BELONGS_TO_PROFILE_WRITABLE',
    path,
    message: `policy.belongsTo('${column}') without "through" trusts profiles.${column} of the current user, but ${how} — `
      + `a user can set profiles.${column} to any tenant id and read/write that tenant's rows`,
    hint: `Prefer a membership table: policy.belongsTo('${column}', { table: 'org_members', foreignKey: '${column}', localKey: 'user_id' }). `
      + `To keep the profiles lookup, make profiles.${column} server-written only: insert: policy.none() (create profiles from an auth trigger or the service role) `
      + `and triggers: [trigger.lockColumns({ columns: ['${column}'] })] on profiles.`,
  });
}

function checkCustomExpression(ctx: Ctx, path: string, expression: unknown): void {
  if (typeof expression !== 'string' || expression.trim().length === 0) {
    push(ctx, {
      severity: 'error',
      code: 'INVALID_POLICY_RULE',
      path,
      message: 'policy.custom() needs a non-empty SQL expression',
    });
    return;
  }
  checkSqlAuthCalls(ctx, path, expression, 'policy.custom()');
}

/**
 * Warn about a bare `auth.uid()` / `auth.jwt()` / `auth.role()` call: in a
 * policy it is re-evaluated for every row instead of once per query (initPlan).
 */
function checkSqlAuthCalls(ctx: Ctx, path: string, sql: string, where: string): void {
  const bare = /(^|[^\w.])auth\.(uid|jwt|role)\(\)/gi;
  let match: RegExpExecArray | null;
  while ((match = bare.exec(sql)) !== null) {
    const before = sql.slice(0, match.index + match[1].length);
    if (/\(\s*select\s+$/i.test(before)) continue;
    push(ctx, {
      severity: 'warning',
      code: 'UNWRAPPED_AUTH_CALL',
      path,
      message: `${where} calls auth.${match[2]}() directly — it is re-evaluated for every row`,
      hint: `Write (SELECT auth.${match[2]}()) so Postgres evaluates it once per query.`,
    });
    return;
  }
}

/** Two triggers with the same generated name would silently replace each other. */
function checkDuplicateTriggers(ctx: Ctx, tableName: string, triggers: any[]): void {
  const seen = new Map<string, number>();
  triggers.forEach((t: any, index: number) => {
    if (!t || typeof t !== 'object') return;
    const suffix = t.kind === 'custom' ? t.name
      : t.kind === 'lock_columns' ? (t.name ?? 'lock_columns')
        : t.kind;
    if (typeof suffix !== 'string') return;
    const first = seen.get(suffix);
    if (first === undefined) {
      seen.set(suffix, index);
      return;
    }
    push(ctx, {
      severity: 'error',
      code: 'DUPLICATE_TRIGGER',
      path: `${tableName}.triggers[${index}]`,
      message: `Trigger "${suffix}" on "${tableName}" is defined twice (also triggers[${first}]); the second would replace the first`,
      hint: t.kind === 'lock_columns' || t.kind === 'custom'
        ? 'Give each one a distinct `name`.'
        : 'Remove the duplicate (softDelete on the table already adds trigger.softDelete).',
    });
  });
}

function checkTrigger(ctx: Ctx, tableName: string, path: string, t: any): void {
  if (!t || typeof t !== 'object' || typeof t.kind !== 'string') {
    push(ctx, {
      severity: 'error',
      code: 'INVALID_TRIGGER',
      path,
      message: 'Triggers must be built with trigger.*()',
      hint: "Example: triggers: [trigger.updatedAt('updated_at')].",
    });
    return;
  }

  const def = ctx.schema[tableName];
  const columns = columnsOf(def);
  const tableHasColumns = hasColumns(def);

  switch (t.kind) {
    case 'updated_at':
    case 'soft_delete':
      if (tableHasColumns && !(t.column in columns)) {
        unknownColumn(ctx, path, tableName, String(t.column), `trigger.${t.kind === 'updated_at' ? 'updatedAt' : 'softDelete'} column`);
      }
      break;
    case 'audit_log': {
      const target = ctx.schema[t.table];
      if (!target) {
        push(ctx, {
          severity: ctx.manual ? 'error' : 'warning',
          code: 'UNKNOWN_TABLE',
          path,
          message: `trigger.auditLog target table "${t.table}" is not in the schema`,
          hint: 'Add an audit table (see the "audit log" recipe in node_modules/accessnexus/llms.txt) or fix the name.',
        });
      } else {
        checkAuditTarget(ctx, tableName, path, String(t.table), target);
      }
      for (const column of Array.isArray(t.columns) ? t.columns : []) {
        if (tableHasColumns && !(column in columns)) {
          unknownColumn(ctx, path, tableName, String(column), 'trigger.auditLog column');
        }
      }
      break;
    }
    case 'lock_columns': {
      const hasColumnsList = Array.isArray(t.columns) && t.columns.length > 0;
      const hasExcept = Array.isArray(t.except) && t.except.length > 0;
      if (hasColumnsList === hasExcept) {
        push(ctx, {
          severity: 'error',
          code: 'INVALID_TRIGGER',
          path,
          message: 'trigger.lockColumns needs exactly one of `columns` (lock these) or `except` (lock all but these)',
          hint: "Example: trigger.lockColumns({ columns: ['owner_id'] }) or trigger.lockColumns({ except: ['status'] }).",
        });
      }
      for (const column of [...(Array.isArray(t.columns) ? t.columns : []), ...(Array.isArray(t.except) ? t.except : [])]) {
        if (tableHasColumns && !(column in columns)) {
          unknownColumn(ctx, path, tableName, String(column), 'trigger.lockColumns column');
        }
      }
      if (t.name !== undefined && (typeof t.name !== 'string' || !IDENTIFIER.test(t.name))) {
        push(ctx, {
          severity: 'error',
          code: 'INVALID_IDENTIFIER',
          path,
          message: `trigger.lockColumns name "${String(t.name)}" must be lowercase snake_case`,
        });
      }
      if (t.unless !== undefined) checkSqlAuthCalls(ctx, path, String(t.unless), 'trigger.lockColumns unless');
      break;
    }
    case 'custom':
      if (t.security !== undefined && t.security !== 'invoker' && t.security !== 'definer') {
        push(ctx, {
          severity: 'error',
          code: 'INVALID_TRIGGER',
          path,
          message: `trigger.custom security must be 'invoker' or 'definer', got ${JSON.stringify(t.security)}`,
        });
      }
      if (typeof t.name !== 'string' || !IDENTIFIER.test(t.name)) {
        push(ctx, {
          severity: 'error',
          code: 'INVALID_IDENTIFIER',
          path,
          message: `trigger.custom name "${String(t.name)}" must be lowercase snake_case`,
        });
      }
      if (!Array.isArray(t.events) || t.events.length === 0) {
        push(ctx, {
          severity: 'error',
          code: 'INVALID_TRIGGER',
          path,
          message: 'trigger.custom needs at least one event',
          hint: "Example: events: ['before_update'].",
        });
      } else {
        for (const event of t.events) {
          if (!TRIGGER_EVENTS.has(event)) {
            push(ctx, {
              severity: 'error',
              code: 'INVALID_TRIGGER',
              path,
              message: `Unknown trigger event "${String(event)}"`,
              hint: `Use one of: ${[...TRIGGER_EVENTS].join(', ')}.`,
            });
          }
        }
      }
      if (typeof t.functionBody !== 'string' || t.functionBody.trim().length === 0) {
        push(ctx, {
          severity: 'error',
          code: 'INVALID_TRIGGER',
          path,
          message: 'trigger.custom needs a functionBody (PL/pgSQL, ending with RETURN NEW/OLD/NULL)',
        });
      }
      break;
    default:
      push(ctx, {
        severity: 'error',
        code: 'INVALID_TRIGGER',
        path,
        message: `Unknown trigger kind "${t.kind}"`,
        hint: 'Use trigger.updatedAt, trigger.softDelete, trigger.auditLog, trigger.lockColumns or trigger.custom.',
      });
  }
}

/** Columns the generated audit trigger inserts into the audit table. */
const AUDIT_COLUMNS = ['table_name', 'operation', 'old_data', 'new_data', 'changed_at'];

function checkAuditTarget(ctx: Ctx, tableName: string, path: string, auditName: string, target: any): void {
  if (hasColumns(target)) {
    const columns = columnsOf(target);
    const missing = AUDIT_COLUMNS.filter((column) => !(column in columns));
    // NOT NULL columns the trigger never fills (and that have no default) make every insert fail.
    const unfilled = Object.entries(columns)
      .filter(([name, input]) => {
        if (AUDIT_COLUMNS.includes(name) || name === target.primaryKey) return false;
        const type = columnType(input) ?? '';
        const hasDefault = typeof input === 'object' && input !== null && (input as any).default !== undefined;
        return !type.endsWith('?') && !hasDefault;
      })
      .map(([name]) => name);
    if (missing.length > 0 || unfilled.length > 0) {
      const problems = [
        missing.length > 0 ? `is missing ${missing.join(', ')}` : '',
        unfilled.length > 0 ? `has required columns the trigger never sets (${unfilled.join(', ')})` : '',
      ].filter(Boolean).join(' and ');
      push(ctx, {
        severity: 'error',
        code: 'AUDIT_TABLE_MISMATCH',
        path,
        message: `trigger.auditLog inserts (${AUDIT_COLUMNS.join(', ')}) into "${auditName}", which ${problems} — every write to "${tableName}" would fail`,
        hint: `Give ${auditName} the columns table_name: 'text', operation: 'text', old_data: 'jsonb?', new_data: 'jsonb?', `
          + "changed_at: { type: 'timestamptz', default: 'now()' }; make any other column nullable or give it a default.",
      });
    }
  }

  // The trigger function is SECURITY DEFINER, so the audit table needs no
  // INSERT policy — and must not have one, or API users can forge entries.
  const insertRule = target?.policies?.insert;
  if (target?.policies && insertRule && insertRule.kind !== 'none') {
    push(ctx, {
      severity: 'warning',
      code: 'AUDIT_INSERT_OPEN',
      path: `${auditName}.policies.insert`,
      message: `"${auditName}" lets API users INSERT, so they can forge audit entries; the audit trigger does not need it (it runs as SECURITY DEFINER)`,
      hint: `Set ${auditName}.policies.insert to policy.none().`,
    });
  }
}

function checkRpc(ctx: Ctx, name: string, def: any): void {
  const path = `rpcs.${name}`;
  if (!IDENTIFIER.test(name)) {
    push(ctx, {
      severity: 'error',
      code: 'INVALID_IDENTIFIER',
      path,
      message: `RPC name "${name}" is not lowercase snake_case`,
    });
  }
  if (!def || def._rpc !== true) {
    push(ctx, {
      severity: 'error',
      code: 'INVALID_RPC',
      path,
      message: `"${name}" must be created with rpc({ ... })`,
    });
    return;
  }
  if (typeof def.body === 'string') {
    checkSqlAuthCalls(ctx, `${path}.body`, def.body, `rpc ${name}`);
  }
  let sawDefault = false;
  for (const [arg, input] of Object.entries((def.args ?? {}) as Record<string, unknown>)) {
    const type = input && typeof input === 'object' ? (input as any).type : input;
    const dflt = input && typeof input === 'object' ? (input as any).default : undefined;
    if (!IDENTIFIER.test(arg)) {
      push(ctx, {
        severity: 'error',
        code: 'INVALID_IDENTIFIER',
        path: `${path}.args.${arg}`,
        message: `RPC argument name "${arg}" is not lowercase snake_case`,
      });
    }
    if (dflt !== undefined && (typeof dflt !== 'string' || dflt.trim() === '')) {
      push(ctx, {
        severity: 'error',
        code: 'INVALID_DEFAULT',
        path: `${path}.args.${arg}.default`,
        message: `Default of RPC argument "${arg}" must be a non-empty SQL expression string`,
        hint: "Example: { type: 'int', default: '20' } or { type: 'text', default: \"'pending'\" }.",
      });
    }
    if (dflt !== undefined) sawDefault = true;
    else if (sawDefault) {
      push(ctx, {
        severity: 'error',
        code: 'INVALID_DEFAULT',
        path: `${path}.args.${arg}`,
        message: `RPC argument "${arg}" has no default but an earlier argument does (Postgres requires defaults on every following argument)`,
        hint: 'Give it a default, or move the arguments with defaults to the end.',
      });
    }
    if (typeof type !== 'string' || !isValidType(type)) {
      push(ctx, {
        severity: 'error',
        code: 'UNKNOWN_COLUMN_TYPE',
        path: `${path}.args.${arg}`,
        message: `Unknown argument type "${String(type)}"`,
        hint: `Use one of: ${[...SCALAR_TYPES].join(', ')}.`,
      });
    }
  }
}
