import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SupabaseAdapter } from '../adapters/supabase/adapter.js';
import { baseType, isNullable, normalizeColumn } from '../core/types/columns.js';
import type { GeneratedOutput, IndexDef, SchemaDef } from '../core/types/index.js';
import { primaryKeyColumns, singlePrimaryKey } from '../core/types/schema.js';

interface ColumnState {
  readonly type: string;
  readonly nullable: boolean;
  readonly default?: string;
  readonly unique: boolean;
  readonly check?: string;
  readonly references?: string;
  readonly onDelete?: string;
}

interface IndexState {
  readonly name: string;
  readonly unique: boolean;
  readonly columns: readonly string[];
  readonly predicate?: string;
}

interface TableState {
  /** Primary key column(s), comma-joined for a composite key ("a, b"). */
  readonly primaryKey?: string;
  readonly softDelete?: string;
  readonly columns: Record<string, ColumnState>;
  readonly indexes: readonly IndexState[];
}

interface SchemaState {
  readonly tables: Record<string, TableState>;
}

interface MigrationSnapshotV1 {
  readonly version: 1;
  readonly lastMigration: number;
  readonly definitionHash: string;
  readonly schemaHash?: string;
}

interface MigrationSnapshotV2 {
  readonly version: 2;
  readonly lastMigration: number;
  readonly definitionHash: string;
  readonly schemaHash: string;
  readonly schemaState: SchemaState;
}

interface MigrationSnapshotV3 {
  readonly version: 3;
  readonly definitionHash: string;
  readonly schemaHash: string;
  readonly schemaState: SchemaState;
  readonly lastMigrationFile: string;
}

type MigrationSnapshot = MigrationSnapshotV1 | MigrationSnapshotV2 | MigrationSnapshotV3;

export function resolveVersionedMigrations(
  schema: SchemaDef,
  adapter: SupabaseAdapter,
  outputBase: string,
): GeneratedOutput[] {
  const generated = adapter.generateMigrations(schema);
  if (generated.length === 0) return [];

  const fallbackSql = generated[0].content;
  const normalizedSqlHash = stableHash(normalizeGeneratedSql(fallbackSql));
  const schemaState = buildSchemaState(schema);
  const schemaHash = stableHash(stableStringify(schemaState));
  const snapshotPath = resolve(outputBase, '.snapshot.json');
  const snapshot = readMigrationSnapshot(snapshotPath);

  if (!snapshot) {
    const filename = nextTimestampMigrationFilename(outputBase, 'init');
    return [
      { path: filename, content: fallbackSql },
      {
        path: '.snapshot.json',
        content: stringifySnapshot({
          version: 3,
          definitionHash: normalizedSqlHash,
          schemaHash,
          schemaState,
          lastMigrationFile: filename,
        }),
      },
    ];
  }

  if ((snapshot.version === 2 || snapshot.version === 3) && snapshot.schemaHash === schemaHash) {
    return [];
  }

  if (snapshot.version === 1) {
    if (snapshot.schemaHash && snapshot.schemaHash === schemaHash) {
      return [];
    }
    if (!snapshot.schemaHash && snapshot.definitionHash === normalizedSqlHash) {
      return [];
    }
  }

  const filename = nextTimestampMigrationFilename(outputBase, 'changes');
  const incrementalSql = snapshot.version === 2
    ? generateIncrementalMigration(snapshot.schemaState, schemaState)
    : snapshot.version === 3
    ? generateIncrementalMigration(snapshot.schemaState, schemaState)
    : fallbackSql;

  const content = incrementalSql.trim().length > 0 ? incrementalSql : '-- No DDL changes detected.\n';

  return [
    { path: filename, content },
    {
      path: '.snapshot.json',
      content: stringifySnapshot({
        version: 3,
        definitionHash: normalizedSqlHash,
        schemaHash,
        schemaState,
        lastMigrationFile: filename,
      }),
    },
  ];
}

function generateIncrementalMigration(previous: SchemaState, current: SchemaState): string {
  const lines: string[] = [];

  lines.push('-- ============================================');
  lines.push('-- AccessNexus: Incremental schema changes');
  lines.push('-- ============================================');
  lines.push('');

  const tableRenames = detectTableRenames(previous, current);
  emitTableRenames(lines, tableRenames);

  const normalizedPrevious = applyTableRenames(previous, tableRenames);

  emitEnumChanges(lines, normalizedPrevious, current);
  emitRemovedTables(lines, normalizedPrevious, current);
  emitAddedTables(lines, current, normalizedPrevious);
  emitChangedTables(lines, normalizedPrevious, current);

  return `${lines.join('\n').trimEnd()}\n`;
}

function emitTableRenames(lines: string[], renames: Map<string, string>): void {
  const ordered = [...renames.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [from, to] of ordered) {
    lines.push(renameTableIfNeeded(from, to));
    lines.push('');
  }
}

function emitEnumChanges(lines: string[], previous: SchemaState, current: SchemaState): void {
  for (const [tableName, table] of Object.entries(current.tables)) {
    const prevTable = previous.tables[tableName];
    for (const [columnName, column] of Object.entries(table.columns)) {
      if (!isEnum(column.type)) continue;
      const enumName = enumTypeName(tableName, columnName);
      const prevColumn = prevTable?.columns[columnName];

      if (!prevColumn || !isEnum(prevColumn.type)) {
        lines.push(createEnumSQL(enumName, column.type));
        lines.push('');
        continue;
      }

      if (prevColumn.type === column.type) continue;

      const previousValues = parseEnumValues(prevColumn.type);
      const currentValues = parseEnumValues(column.type);
      const addedValues = currentValues.filter((value) => !previousValues.includes(value));
      const removedValues = previousValues.filter((value) => !currentValues.includes(value));

      for (const value of addedValues) {
        lines.push(`ALTER TYPE ${enumName} ADD VALUE IF NOT EXISTS '${escapeSqlString(value)}';`);
      }

      if (removedValues.length > 0) {
        lines.push(`-- Manual action required: enum ${enumName} removed values (${removedValues.join(', ')}).`);
      }

      if (addedValues.length > 0 || removedValues.length > 0) {
        lines.push('');
      }
    }
  }
}

function emitRemovedTables(lines: string[], previous: SchemaState, current: SchemaState): void {
  for (const tableName of Object.keys(previous.tables)) {
    if (current.tables[tableName]) continue;
    lines.push(`-- Destructive: table ${tableName} will be dropped.`);
    lines.push(`DROP TABLE IF EXISTS ${tableName} CASCADE;`);
    lines.push('');
  }
}

function emitAddedTables(lines: string[], current: SchemaState, previous: SchemaState): void {
  const ordered = orderTablesByDependencies(current);

  for (const tableName of ordered) {
    if (previous.tables[tableName]) continue;
    const table = current.tables[tableName];
    lines.push(createTableSQL(tableName, table));
    const indexStatements = createIndexesSQL(tableName, table.indexes);
    if (indexStatements.length > 0) {
      lines.push(...indexStatements);
    }
    lines.push('');
  }
}

function emitChangedTables(lines: string[], previous: SchemaState, current: SchemaState): void {
  const commonTables = Object.keys(current.tables).filter((tableName) => previous.tables[tableName]);
  commonTables.sort();

  for (const tableName of commonTables) {
    const originalBefore = previous.tables[tableName];
    const after = current.tables[tableName];
    const tableLines: string[] = [];

    const columnRenames = detectColumnRenames(originalBefore, after);
    emitColumnRenames(tableLines, tableName, columnRenames);
    const before = applyColumnRenames(originalBefore, columnRenames);

    emitPrimaryKeyChanges(tableLines, tableName, before, after);
    emitColumnDrops(tableLines, tableName, before, after);
    emitColumnAdds(tableLines, tableName, before, after);
    emitColumnAlterations(tableLines, tableName, before, after);
    emitIndexChanges(tableLines, tableName, before, after);

    if (tableLines.length > 0) {
      lines.push(...tableLines);
      lines.push('');
    }
  }
}

function emitColumnRenames(lines: string[], tableName: string, renames: Map<string, string>): void {
  const ordered = [...renames.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [from, to] of ordered) {
    lines.push(renameColumnIfNeeded(tableName, from, to));
  }
}

function emitPrimaryKeyChanges(lines: string[], tableName: string, before: TableState, after: TableState): void {
  if (before.primaryKey === after.primaryKey) return;

  if (before.primaryKey) {
    lines.push(`ALTER TABLE ${tableName} DROP CONSTRAINT IF EXISTS ${tableName}_pkey;`);
  }
  if (after.primaryKey) {
    lines.push(addConstraintIfMissing(tableName, `${tableName}_pkey`, `PRIMARY KEY (${after.primaryKey})`));
  }
}

function emitColumnDrops(lines: string[], tableName: string, before: TableState, after: TableState): void {
  for (const columnName of Object.keys(before.columns)) {
    if (after.columns[columnName]) continue;
    lines.push(`-- Destructive: column ${tableName}.${columnName} will be dropped.`);
    lines.push(`ALTER TABLE ${tableName} DROP COLUMN IF EXISTS ${columnName};`);
  }
}

function emitColumnAdds(lines: string[], tableName: string, before: TableState, after: TableState): void {
  for (const [columnName, column] of Object.entries(after.columns)) {
    if (before.columns[columnName]) continue;

    lines.push(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${columnDefinition(tableName, columnName, column)};`);
    syncColumnConstraints(lines, tableName, columnName, undefined, column);
  }
}

function emitColumnAlterations(lines: string[], tableName: string, before: TableState, after: TableState): void {
  const shared = Object.keys(after.columns).filter((columnName) => before.columns[columnName]);
  shared.sort();

  for (const columnName of shared) {
    const oldColumn = before.columns[columnName];
    const newColumn = after.columns[columnName];

    if (oldColumn.type !== newColumn.type) {
      lines.push(`ALTER TABLE ${tableName} ALTER COLUMN ${columnName} TYPE ${columnTypeToPG(newColumn.type, tableName, columnName)};`);
    }

    if (oldColumn.nullable !== newColumn.nullable) {
      lines.push(
        newColumn.nullable
          ? `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} DROP NOT NULL;`
          : `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} SET NOT NULL;`,
      );
    }

    if (oldColumn.default !== newColumn.default) {
      lines.push(
        newColumn.default === undefined
          ? `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} DROP DEFAULT;`
          : `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} SET DEFAULT ${newColumn.default};`,
      );
    }

    syncColumnConstraints(lines, tableName, columnName, oldColumn, newColumn);
  }
}

function syncColumnConstraints(
  lines: string[],
  tableName: string,
  columnName: string,
  oldColumn: ColumnState | undefined,
  newColumn: ColumnState,
): void {
  const uniqueName = uniqueConstraintName(tableName, columnName);
  if ((oldColumn?.unique ?? false) !== newColumn.unique) {
    lines.push(
      newColumn.unique
        ? addConstraintIfMissing(tableName, uniqueName, `UNIQUE (${columnName})`)
        : `ALTER TABLE ${tableName} DROP CONSTRAINT IF EXISTS ${uniqueName};`,
    );
  }

  const checkName = checkConstraintName(tableName, columnName);
  if ((oldColumn?.check ?? undefined) !== newColumn.check) {
    if (oldColumn?.check) {
      lines.push(`ALTER TABLE ${tableName} DROP CONSTRAINT IF EXISTS ${checkName};`);
    }
    if (newColumn.check) {
      lines.push(addConstraintIfMissing(tableName, checkName, `CHECK (${newColumn.check})`));
    }
  }

  const fkName = fkConstraintName(tableName, columnName);
  if (
    (oldColumn?.references ?? undefined) !== newColumn.references
    || (oldColumn?.onDelete ?? undefined) !== newColumn.onDelete
  ) {
    if (oldColumn?.references) {
      lines.push(`ALTER TABLE ${tableName} DROP CONSTRAINT IF EXISTS ${fkName};`);
      // A FK declared inline in CREATE TABLE gets Postgres' default name.
      lines.push(`ALTER TABLE ${tableName} DROP CONSTRAINT IF EXISTS ${defaultFkConstraintName(tableName, columnName)};`);
    }
    if (newColumn.references) {
      const parsed = parseReference(newColumn.references);
      lines.push(addConstraintIfMissing(
        tableName,
        fkName,
        `FOREIGN KEY (${columnName}) REFERENCES ${parsed.tablePath}(${parsed.column})${onDeleteClause(newColumn.onDelete)}`,
      ));
    }
  }
}

function emitIndexChanges(lines: string[], tableName: string, before: TableState, after: TableState): void {
  const beforeMap = new Map(before.indexes.map((index) => [indexSignature(index), index]));
  const afterMap = new Map(after.indexes.map((index) => [indexSignature(index), index]));

  for (const [signature, index] of beforeMap) {
    if (afterMap.has(signature)) continue;
    lines.push(`DROP INDEX IF EXISTS ${index.name};`);
  }

  for (const [signature, index] of afterMap) {
    if (beforeMap.has(signature)) continue;
    const unique = index.unique ? 'UNIQUE ' : '';
    const where = index.predicate ? ` WHERE ${index.predicate}` : '';
    lines.push(`CREATE ${unique}INDEX IF NOT EXISTS ${index.name} ON ${tableName}(${index.columns.join(', ')})${where};`);
  }
}

function createTableSQL(tableName: string, table: TableState): string {
  const definitions: string[] = [];
  for (const [columnName, column] of Object.entries(table.columns)) {
    const parts: string[] = [columnName, columnTypeToPG(column.type, tableName, columnName)];
    const isPrimary = table.primaryKey === columnName;

    if (!column.nullable && !isPrimary) parts.push('NOT NULL');
    if (isPrimary && column.type === 'bigint' && column.default === undefined) {
      parts.push('GENERATED ALWAYS AS IDENTITY');
    }
    if (isPrimary && column.type === 'uuid' && column.default === undefined) {
      parts.push('DEFAULT gen_random_uuid()');
    }
    if (column.default !== undefined) parts.push(`DEFAULT ${column.default}`);
    if (column.unique) parts.push('UNIQUE');
    if (column.check) parts.push(`CHECK (${column.check})`);
    if (column.references) {
      const ref = parseReference(column.references);
      parts.push(`REFERENCES ${ref.tablePath}(${ref.column})${onDeleteClause(column.onDelete)}`);
    }
    if (isPrimary) parts.push('PRIMARY KEY');

    definitions.push(`  ${parts.join(' ')}`);
  }
  if (table.primaryKey?.includes(',')) definitions.push(`  PRIMARY KEY (${table.primaryKey})`);

  return `CREATE TABLE IF NOT EXISTS ${tableName} (\n${definitions.join(',\n')}\n);`;
}

function createIndexesSQL(tableName: string, indexes: readonly IndexState[]): string[] {
  return indexes.map((index) => {
    const unique = index.unique ? 'UNIQUE ' : '';
    const where = index.predicate ? ` WHERE ${index.predicate}` : '';
    return `CREATE ${unique}INDEX IF NOT EXISTS ${index.name} ON ${tableName}(${index.columns.join(', ')})${where};`;
  });
}

function columnDefinition(tableName: string, columnName: string, column: ColumnState): string {
  const parts: string[] = [columnName, columnTypeToPG(column.type, tableName, columnName)];
  if (!column.nullable) parts.push('NOT NULL');
  if (column.default !== undefined) parts.push(`DEFAULT ${column.default}`);
  return parts.join(' ');
}

function columnTypeToPG(type: string, tableName: string, columnName: string): string {
  const map: Record<string, string> = {
    uuid: 'UUID',
    text: 'TEXT',
    varchar: 'VARCHAR',
    int: 'INTEGER',
    smallint: 'SMALLINT',
    bigint: 'BIGINT',
    serial: 'SERIAL',
    float: 'DOUBLE PRECISION',
    decimal: 'NUMERIC',
    boolean: 'BOOLEAN',
    json: 'JSON',
    jsonb: 'JSONB',
    date: 'DATE',
    timestamp: 'TIMESTAMP',
    timestamptz: 'TIMESTAMPTZ',
    time: 'TIME',
    'text[]': 'TEXT[]',
    'int[]': 'INTEGER[]',
    'uuid[]': 'UUID[]',
  };

  if (isEnum(type)) {
    return enumTypeName(tableName, columnName);
  }

  return map[type] ?? type.toUpperCase();
}

function buildSchemaState(schema: SchemaDef): SchemaState {
  const tables: Record<string, TableState> = {};

  for (const [tableName, tableDef] of Object.entries(schema)) {
    if (Object.keys(tableDef.columns).length === 0) continue;

    const tableLevelRefs = tableDef.references as Record<string, string> | undefined;
    const columns: Record<string, ColumnState> = {};

    for (const [columnName, rawColumn] of Object.entries(tableDef.columns)) {
      const column = normalizeColumn(rawColumn);
      const type = baseType(column.type);
      const reference = column.references ?? tableLevelRefs?.[columnName];
      const onDelete = reference ? (column.onDelete ?? tableDef.onDelete?.[columnName]) : undefined;

      columns[columnName] = removeUndefined({
        type,
        nullable: isNullable(column.type),
        default: column.default,
        unique: column.unique ?? false,
        check: column.check,
        references: reference,
        onDelete,
      });
    }

    tables[tableName] = {
      primaryKey: primaryKeyColumns(tableDef).join(', ') || undefined,
      softDelete: tableDef.softDelete,
      columns,
      indexes: normalizeIndexes(tableName, tableDef.indexes, columns, singlePrimaryKey(tableDef), tableDef.softDelete),
    };
  }

  return { tables };
}

function normalizeIndexes(
  tableName: string,
  indexes: readonly IndexDef[] | undefined,
  columns: Record<string, ColumnState>,
  primaryKey: string | undefined,
  softDelete: string | undefined,
): readonly IndexState[] {
  const explicit = indexes ?? [];
  const result: IndexState[] = explicit.map((index, idx) => ({
    name: index.name ?? `idx_${tableName}_${index.columns.join('_')}_${idx + 1}`,
    unique: index.unique ?? false,
    columns: [...index.columns],
  }));

  const explicitSignatures = new Set(result.map((idx) => `${idx.unique ? 'u' : 'n'}|${idx.columns.join(',')}`));
  for (const [columnName, column] of Object.entries(columns)) {
    if (!column.references) continue;
    // The primary key / a UNIQUE column already has an index.
    if (columnName === primaryKey || column.unique) continue;
    const signature = `n|${columnName}`;
    if (explicitSignatures.has(signature)) continue;
    result.push({
      name: `idx_${tableName}_${columnName}_fk`,
      unique: false,
      columns: [columnName],
    });
  }

  if (primaryKey && softDelete) {
    const signature = `n|${primaryKey}|${softDelete} IS NULL`;
    const existing = new Set(result.map((idx) => `n|${idx.columns.join(',')}|${idx.predicate ?? ''}`));
    if (!existing.has(signature)) {
      result.push({
        name: `idx_${tableName}_active_pk`,
        unique: false,
        columns: [primaryKey],
        predicate: `${softDelete} IS NULL`,
      });
    }
  }

  return result;
}

function orderTablesByDependencies(state: SchemaState): string[] {
  const tableNames = Object.keys(state.tables);
  const tableSet = new Set(tableNames);
  const deps = new Map<string, Set<string>>();

  for (const tableName of tableNames) {
    deps.set(tableName, new Set<string>());
    const table = state.tables[tableName];
    for (const column of Object.values(table.columns)) {
      if (!column.references) continue;
      const parts = column.references.split('.');
      const refTable = parts.length === 3 ? parts[1] : parts[0];
      const isExternal = parts.length === 3;
      if (!isExternal && tableSet.has(refTable)) {
        deps.get(tableName)!.add(refTable);
      }
    }
  }

  const sorted: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (table: string) => {
    if (visited.has(table)) return;
    if (visiting.has(table)) return;
    visiting.add(table);
    for (const dep of deps.get(table) ?? []) {
      visit(dep);
    }
    visiting.delete(table);
    visited.add(table);
    sorted.push(table);
  };

  for (const tableName of tableNames) {
    visit(tableName);
  }

  return sorted;
}

function uniqueConstraintName(tableName: string, columnName: string): string {
  return `uq_${tableName}_${columnName}`;
}

function checkConstraintName(tableName: string, columnName: string): string {
  return `ck_${tableName}_${columnName}`;
}

function fkConstraintName(tableName: string, columnName: string): string {
  return `fk_${tableName}_${columnName}`;
}

/** Name Postgres gives an inline `REFERENCES` constraint (identifiers cap at 63 bytes). */
function defaultFkConstraintName(tableName: string, columnName: string): string {
  return `${tableName}_${columnName}_fkey`.slice(0, 63);
}

function onDeleteClause(action: string | undefined): string {
  return action ? ` ON DELETE ${action.toUpperCase()}` : '';
}

function indexSignature(index: IndexState): string {
  return `${index.unique ? 'u' : 'n'}|${index.name}|${index.columns.join(',')}|${index.predicate ?? ''}`;
}

function isEnum(type: string): boolean {
  return type.startsWith('enum(');
}

function enumTypeName(tableName: string, columnName: string): string {
  return `${tableName}_${columnName}_enum`;
}

function createEnumSQL(enumName: string, enumType: string): string {
  const values = parseEnumValues(enumType).map((value) => `'${escapeSqlString(value)}'`);
  return [
    `DO $$`,
    `BEGIN`,
    `  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = '${escapeSqlString(enumName)}') THEN`,
    `    CREATE TYPE ${enumName} AS ENUM (${values.join(', ')});`,
    `  END IF;`,
    `END $$;`,
  ].join('\n');
}

function parseEnumValues(enumType: string): string[] {
  const match = enumType.match(/^enum\((.*)\)$/);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((item) => item.trim())
    .map((item) => item.replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function parseReference(reference: string): { tablePath: string; column: string } {
  const parts = reference.split('.');
  if (parts.length === 2) return { tablePath: parts[0], column: parts[1] };
  if (parts.length === 3) return { tablePath: `${parts[0]}.${parts[1]}`, column: parts[2] };
  throw new Error(`[AccessNexus] Invalid reference "${reference}"`);
}

function escapeSqlString(value: string): string {
  return value.replaceAll("'", "''");
}

function readMigrationSnapshot(snapshotPath: string): MigrationSnapshot | null {
  if (!existsSync(snapshotPath)) return null;

  try {
    const raw = readFileSync(snapshotPath, 'utf-8');
    const data = JSON.parse(raw) as Partial<MigrationSnapshot>;
    if (data.version === 1 && typeof data.lastMigration === 'number' && typeof data.definitionHash === 'string') {
      return {
        version: 1,
        lastMigration: data.lastMigration,
        definitionHash: data.definitionHash,
        schemaHash: typeof data.schemaHash === 'string' ? data.schemaHash : undefined,
      };
    }
    if (
      data.version === 2 &&
      typeof data.lastMigration === 'number' &&
      typeof data.definitionHash === 'string' &&
      typeof data.schemaHash === 'string' &&
      data.schemaState &&
      typeof data.schemaState === 'object'
    ) {
      return data as MigrationSnapshotV2;
    }
    if (
      data.version === 3 &&
      typeof data.definitionHash === 'string' &&
      typeof data.schemaHash === 'string' &&
      typeof (data as any).lastMigrationFile === 'string' &&
      data.schemaState &&
      typeof data.schemaState === 'object'
    ) {
      return data as MigrationSnapshotV3;
    }
    return null;
  } catch {
    return null;
  }
}

function stringifySnapshot(snapshot: MigrationSnapshotV3): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function nextTimestampMigrationFilename(outputBase: string, suffix: 'init' | 'changes'): string {
  const absoluteBase = resolve(outputBase);
  const usedNames = new Set<string>();
  if (existsSync(absoluteBase)) {
    for (const name of readdirSync(absoluteBase)) {
      if (name.endsWith('.sql')) usedNames.add(name);
    }
  }

  const base = `${migrationTimestamp()}__${suffix}`;
  let candidate = `${base}.sql`;
  let index = 1;
  while (usedNames.has(candidate)) {
    candidate = `${base}_${String(index).padStart(2, '0')}.sql`;
    index += 1;
  }
  return candidate;
}

function migrationTimestamp(date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  const second = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}${month}${day}${hour}${minute}${second}`;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizeGeneratedSql(sql: string): string {
  return sql
    .replace(/^-- Generated at: .*\n?/gm, '')
    .trim();
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `"${key}":${stableStringify(val)}`);
    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(value);
}

function renameTableIfNeeded(from: string, to: string): string {
  return [
    `DO $$`,
    `BEGIN`,
    `  IF to_regclass('${escapeSqlString(from)}') IS NOT NULL`,
    `     AND to_regclass('${escapeSqlString(to)}') IS NULL THEN`,
    `    ALTER TABLE ${from} RENAME TO ${to};`,
    `  END IF;`,
    `END $$;`,
  ].join('\n');
}

function renameColumnIfNeeded(tableName: string, from: string, to: string): string {
  return [
    `DO $$`,
    `BEGIN`,
    `  IF EXISTS (`,
    `    SELECT 1`,
    `    FROM information_schema.columns`,
    `    WHERE table_schema = 'public'`,
    `      AND table_name = '${escapeSqlString(tableName)}'`,
    `      AND column_name = '${escapeSqlString(from)}'`,
    `  )`,
    `  AND NOT EXISTS (`,
    `    SELECT 1`,
    `    FROM information_schema.columns`,
    `    WHERE table_schema = 'public'`,
    `      AND table_name = '${escapeSqlString(tableName)}'`,
    `      AND column_name = '${escapeSqlString(to)}'`,
    `  ) THEN`,
    `    ALTER TABLE ${tableName} RENAME COLUMN ${from} TO ${to};`,
    `  END IF;`,
    `END $$;`,
  ].join('\n');
}

function addConstraintIfMissing(tableName: string, constraintName: string, definition: string): string {
  return [
    `DO $$`,
    `BEGIN`,
    `  IF NOT EXISTS (`,
    `    SELECT 1 FROM pg_constraint`,
    `    WHERE conname = '${escapeSqlString(constraintName)}'`,
    `      AND conrelid = '${escapeSqlString(tableName)}'::regclass`,
    `  ) THEN`,
    `    ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} ${definition};`,
    `  END IF;`,
    `END $$;`,
  ].join('\n');
}

function detectTableRenames(previous: SchemaState, current: SchemaState): Map<string, string> {
  const removed = Object.keys(previous.tables).filter((name) => !current.tables[name]);
  const added = Object.keys(current.tables).filter((name) => !previous.tables[name]);
  const renames = new Map<string, string>();
  const usedAdded = new Set<string>();

  for (const oldName of removed) {
    const oldTable = previous.tables[oldName];
    if (tableHasEnumColumns(oldTable)) continue;

    const matches = added.filter((newName) => {
      if (usedAdded.has(newName)) return false;
      const newTable = current.tables[newName];
      if (tableHasEnumColumns(newTable)) return false;
      return tableRenameSignature(oldTable) === tableRenameSignature(newTable);
    });

    if (matches.length !== 1) continue;
    renames.set(oldName, matches[0]);
    usedAdded.add(matches[0]);
  }

  return renames;
}

function applyTableRenames(previous: SchemaState, renames: Map<string, string>): SchemaState {
  if (renames.size === 0) return previous;

  const tables: Record<string, TableState> = {};
  for (const [name, table] of Object.entries(previous.tables)) {
    const renamed = renames.get(name) ?? name;
    tables[renamed] = table;
  }
  return { tables };
}

function detectColumnRenames(before: TableState, after: TableState): Map<string, string> {
  const removed = Object.keys(before.columns).filter((name) => !after.columns[name]);
  const added = Object.keys(after.columns).filter((name) => !before.columns[name]);
  const renames = new Map<string, string>();
  const usedAdded = new Set<string>();

  for (const oldName of removed) {
    const oldColumn = before.columns[oldName];
    if (isEnum(oldColumn.type)) continue;

    const matches = added.filter((newName) => {
      if (usedAdded.has(newName)) return false;
      const newColumn = after.columns[newName];
      if (isEnum(newColumn.type)) return false;
      return columnRenameCompatible(oldColumn, newColumn);
    });

    if (matches.length !== 1) continue;
    renames.set(oldName, matches[0]);
    usedAdded.add(matches[0]);
  }

  return renames;
}

function applyColumnRenames(table: TableState, renames: Map<string, string>): TableState {
  if (renames.size === 0) return table;

  const columns: Record<string, ColumnState> = {};
  for (const [name, column] of Object.entries(table.columns)) {
    columns[renames.get(name) ?? name] = column;
  }

  const indexes = table.indexes.map((index) => ({
    ...index,
    columns: index.columns.map((column) => renames.get(column) ?? column),
  }));

  const primaryKey = table.primaryKey
    ? table.primaryKey.split(', ').map((column) => renames.get(column) ?? column).join(', ')
    : undefined;
  return {
    primaryKey,
    columns,
    indexes,
  };
}

function tableHasEnumColumns(table: TableState): boolean {
  return Object.values(table.columns).some((column) => isEnum(column.type));
}

function tableRenameSignature(table: TableState): string {
  const indexSignatureValue = table.indexes
    .map((index) => `${index.unique ? 'u' : 'n'}:${index.columns.join(',')}`)
    .sort()
    .join('|');
  return stableStringify({
    primaryKey: table.primaryKey,
    columns: table.columns,
    indexes: indexSignatureValue,
  });
}

function columnRenameCompatible(oldColumn: ColumnState, newColumn: ColumnState): boolean {
  return (
    oldColumn.type === newColumn.type &&
    oldColumn.nullable === newColumn.nullable &&
    oldColumn.default === newColumn.default &&
    oldColumn.unique === newColumn.unique &&
    oldColumn.check === newColumn.check &&
    oldColumn.references === newColumn.references &&
    oldColumn.onDelete === newColumn.onDelete
  );
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;
}
