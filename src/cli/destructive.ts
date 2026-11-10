// ============================================
// AccessNexus CLI - Destructive statement detection
// Flags migration SQL that can lose data (dropped tables/columns, type
// changes) so generate/diff/push can warn, and push can refuse to apply it
// without --allow-destructive.
// ============================================

const DESTRUCTIVE_PATTERNS: ReadonlyArray<{ pattern: RegExp; kind: string }> = [
  { pattern: /\bDROP\s+TABLE\b/i, kind: 'drop_table' },
  { pattern: /\bDROP\s+COLUMN\b/i, kind: 'drop_column' },
  { pattern: /\bALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i, kind: 'alter_column_type' },
  { pattern: /\bDROP\s+TYPE\b/i, kind: 'drop_type' },
  { pattern: /\bTRUNCATE\b/i, kind: 'truncate' },
];

export interface DestructiveStatement {
  /** File the statement is in (as displayed to the user). */
  file: string;
  /** 1-based line number. */
  line: number;
  kind: string;
  sql: string;
}

/** Statements in `sql` that can destroy data. Comment lines are ignored. */
export function findDestructiveStatements(file: string, sql: string): DestructiveStatement[] {
  const found: DestructiveStatement[] = [];
  sql.split('\n').forEach((raw, index) => {
    const text = raw.trim();
    if (text === '' || text.startsWith('--')) return;
    for (const { pattern, kind } of DESTRUCTIVE_PATTERNS) {
      if (pattern.test(text)) {
        found.push({ file, line: index + 1, kind, sql: text });
        break;
      }
    }
  });
  return found;
}

/** A column added as NOT NULL without a default (fails on a table that has rows). */
export interface NotNullColumnAdd {
  file: string;
  line: number;
  table: string;
  column: string;
  sql: string;
}

/**
 * `ALTER TABLE t ADD COLUMN ... NOT NULL` statements without `DEFAULT` (or
 * identity) in incremental migrations: Postgres rejects them on a table with
 * rows (23502). New tables are created with CREATE TABLE, so never match.
 */
export function findNotNullColumnAdds(file: string, sql: string): NotNullColumnAdd[] {
  const found: NotNullColumnAdd[] = [];
  sql.split('\n').forEach((raw, index) => {
    const text = raw.trim();
    const m = /^ALTER\s+TABLE\s+(\S+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)\s+(.*);$/i.exec(text);
    if (!m) return;
    const rest = m[3];
    if (!/\bNOT\s+NULL\b/i.test(rest) || /\bDEFAULT\b/i.test(rest) || /\bGENERATED\b/i.test(rest)) return;
    found.push({ file, line: index + 1, table: m[1].replace(/^public\./, ''), column: m[2], sql: text });
  });
  return found;
}
