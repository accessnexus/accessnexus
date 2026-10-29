import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve, extname } from 'node:path';

export type DiffStatus = 'added' | 'modified' | 'removed';

export interface ExpectedFile {
  readonly absolutePath: string;
  readonly displayPath: string;
  readonly content: string;
}

export interface OutputScope {
  readonly baseDir: string;
  readonly allowedExtensions: readonly string[];
  readonly trackRemovals?: boolean;
}

export interface DiffEntry {
  readonly status: DiffStatus;
  readonly absolutePath: string;
  readonly displayPath: string;
  readonly oldContent: string;
  readonly newContent: string;
}

/**
 * Drop the volatile `-- Generated at: <timestamp>` header line so two generations
 * of the same schema compare equal. Only the header line is ignored.
 */
export function stripVolatileHeader(content: string): string {
  return content.replace(/^-- Generated at: .*\r?\n?/m, '');
}

export function collectExistingFiles(
  scopes: readonly OutputScope[],
  expectedFiles: readonly ExpectedFile[] = [],
): Map<string, string> {
  const files = new Map<string, string>();
  const expectedByScope = new Map<string, ExpectedFile[]>();

  for (const file of expectedFiles) {
    const absolutePath = file.absolutePath;
    for (const scope of scopes) {
      const absoluteBase = resolve(process.cwd(), scope.baseDir);
      const prefix = absoluteBase.endsWith('/') ? absoluteBase : `${absoluteBase}/`;
      if (absolutePath.startsWith(prefix)) {
        if (!expectedByScope.has(absoluteBase)) expectedByScope.set(absoluteBase, []);
        expectedByScope.get(absoluteBase)!.push(file);
      }
    }
  }

  for (const scope of scopes) {
    const absoluteBase = resolve(process.cwd(), scope.baseDir);

    if (scope.trackRemovals === false) {
      const expectedInScope = expectedByScope.get(absoluteBase) ?? [];
      for (const expected of expectedInScope) {
        if (!existsSync(expected.absolutePath)) continue;
        files.set(expected.absolutePath, readFileSync(expected.absolutePath, 'utf-8'));
      }
      continue;
    }

    for (const file of listFilesRecursive(absoluteBase, scope.allowedExtensions)) {
      files.set(file.absolutePath, file.content);
    }
  }

  return files;
}

export function buildDiff(
  expectedFiles: readonly ExpectedFile[],
  existingFiles: ReadonlyMap<string, string>,
): DiffEntry[] {
  const expectedMap = new Map<string, ExpectedFile>();
  for (const file of expectedFiles) {
    expectedMap.set(file.absolutePath, file);
  }

  const entries: DiffEntry[] = [];

  for (const file of expectedFiles) {
    const current = existingFiles.get(file.absolutePath);
    if (current === undefined) {
      entries.push({
        status: 'added',
        absolutePath: file.absolutePath,
        displayPath: file.displayPath,
        oldContent: '',
        newContent: file.content,
      });
      continue;
    }

    if (stripVolatileHeader(current) !== stripVolatileHeader(file.content)) {
      entries.push({
        status: 'modified',
        absolutePath: file.absolutePath,
        displayPath: file.displayPath,
        oldContent: current,
        newContent: file.content,
      });
    }
  }

  for (const [absolutePath, currentContent] of existingFiles.entries()) {
    if (expectedMap.has(absolutePath)) continue;

    entries.push({
      status: 'removed',
      absolutePath,
      displayPath: toDisplayPath(absolutePath),
      oldContent: currentContent,
      newContent: '',
    });
  }

  return entries.sort((a, b) => a.displayPath.localeCompare(b.displayPath));
}

export function renderUnifiedDiff(entry: DiffEntry): string {
  const oldLines = splitLines(entry.oldContent);
  const newLines = splitLines(entry.newContent);
  const ops = diffLines(oldLines, newLines);

  const header = [
    `--- a/${entry.displayPath}`,
    `+++ b/${entry.displayPath}`,
  ];

  // Only the changed hunks, with DIFF_CONTEXT lines around each change.
  const changed = ops.map((op) => op.type !== 'context');
  const keep = changed.map((_, i) => {
    for (let j = Math.max(0, i - DIFF_CONTEXT); j <= Math.min(ops.length - 1, i + DIFF_CONTEXT); j++) {
      if (changed[j]) return true;
    }
    return false;
  });

  const body: string[] = [];
  let inHunk = false;
  ops.forEach((op, i) => {
    if (!keep[i]) {
      inHunk = false;
      return;
    }
    if (!inHunk) body.push('@@');
    inHunk = true;
    body.push(`${diffPrefix(op.type)}${op.line}`);
  });
  return [...header, ...body].join('\n');
}

const DIFF_CONTEXT = 3;

interface ListedFile {
  readonly absolutePath: string;
  readonly content: string;
}

interface DiffOp {
  readonly type: 'context' | 'add' | 'remove';
  readonly line: string;
}

function listFilesRecursive(dir: string, allowedExtensions: readonly string[]): ListedFile[] {
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir, { withFileTypes: true });
  const files: ListedFile[] = [];

  for (const entry of entries) {
    const absolutePath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      files.push(...listFilesRecursive(absolutePath, allowedExtensions));
      continue;
    }

    if (!entry.isFile()) continue;

    const extension = extname(entry.name);
    if (!allowedExtensions.includes(extension)) continue;

    files.push({
      absolutePath,
      content: readFileSync(absolutePath, 'utf-8'),
    });
  }

  return files;
}

function toDisplayPath(absolutePath: string): string {
  return relative(process.cwd(), absolutePath).replaceAll('\\', '/');
}

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  return content.split('\n');
}

function diffPrefix(type: DiffOp['type']): string {
  if (type === 'add') return '+';
  if (type === 'remove') return '-';
  return ' ';
}

function diffLines(oldLines: string[], newLines: string[]): DiffOp[] {
  const dp = buildLcsMatrix(oldLines, newLines);
  const ops: DiffOp[] = [];

  let i = 0;
  let j = 0;

  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: 'context', line: oldLines[i] });
      i++;
      j++;
      continue;
    }

    if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'remove', line: oldLines[i] });
      i++;
    } else {
      ops.push({ type: 'add', line: newLines[j] });
      j++;
    }
  }

  while (i < oldLines.length) {
    ops.push({ type: 'remove', line: oldLines[i] });
    i++;
  }

  while (j < newLines.length) {
    ops.push({ type: 'add', line: newLines[j] });
    j++;
  }

  return ops;
}

function buildLcsMatrix(oldLines: string[], newLines: string[]): number[][] {
  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  return dp;
}
