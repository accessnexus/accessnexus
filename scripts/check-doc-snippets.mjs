#!/usr/bin/env node
// Typechecks every TypeScript snippet that imports from 'accessnexus' in
// llms.txt, README.md and docs/**/*.md against the current source. Coding
// agents copy these snippets literally, so a wrong one is a bug.
//
// Usage: node scripts/check-doc-snippets.mjs [files...]

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, '.snippets-tmp');
const SKIP_DIRS = new Set(['.vitepress', 'node_modules', 'supabase-postgres-best-practices']);
const IMPORTS_PACKAGE = /from\s+['"]accessnexus(\/adapters\/supabase)?['"]/;

function markdownFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return SKIP_DIRS.has(name) ? [] : markdownFiles(path);
    return name.endsWith('.md') ? [path] : [];
  });
}

/** ```ts / ```typescript blocks (VitePress titles like ```ts [schema.ts] allowed). */
function extractSnippets(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const snippets = [];
  let start = -1;
  let body = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (start === -1) {
      if (/^\s*```(ts|typescript)\b/.test(line)) {
        start = i + 1;
        body = [];
      }
    } else if (/^\s*```\s*$/.test(line)) {
      const code = body.join('\n');
      if (IMPORTS_PACKAGE.test(code)) snippets.push({ file, line: start, code });
      start = -1;
    } else {
      body.push(line);
    }
  }
  return snippets;
}

const args = process.argv.slice(2);
const files = args.length > 0
  ? args.map((f) => resolve(f))
  : [join(ROOT, 'llms.txt'), join(ROOT, 'README.md'), ...markdownFiles(join(ROOT, 'docs'))];

const snippets = files.flatMap(extractSnippets);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const origin = new Map();
snippets.forEach((snippet, index) => {
  const name = `snippet_${String(index).padStart(3, '0')}.ts`;
  // Strip VitePress line annotations such as // [!code ++]
  writeFileSync(join(OUT, name), `${snippet.code.replace(/\s*\/\/ \[!code [^\]]+\]/g, '')}\nexport {};\n`);
  origin.set(name, snippet);
});

// Snippets import the user's own files (./accessnexus.schema.js, ./database.types.js):
// stub each one, exporting every imported name as both a type and an `any` value.
const stubs = new Map();
for (const { code } of snippets) {
  for (const m of code.matchAll(/import\s+(type\s+)?([^'"]*?)\s+from\s+['"](\.\/[^'"]+)['"]/g)) {
    const names = stubs.get(m[3]) ?? new Set();
    const clause = m[2];
    if (/^[A-Za-z_$][\w$]*/.test(clause) && !clause.startsWith('{')) names.add('default');
    for (const part of /\{([^}]*)\}/.exec(clause)?.[1].split(',') ?? []) {
      const name = part.replace(/^\s*type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (name) names.add(name);
    }
    stubs.set(m[3], names);
  }
}
for (const [specifier, names] of stubs) {
  const lines = ['/* eslint-disable */'];
  for (const name of names) {
    if (name === 'default') lines.push('declare const __default: any;', 'export default __default;');
    else lines.push(`export declare const ${name}: any;`, `export type ${name} = any;`);
  }
  if (names.size === 0) lines.push('export {};');
  writeFileSync(join(OUT, specifier.replace(/^\.\//, '').replace(/\.js$/, '') + '.ts'), `${lines.join('\n')}\n`);
}

writeFileSync(join(OUT, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'bundler',
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    types: ['node'],
    paths: {
      accessnexus: ['../src/index.ts'],
      'accessnexus/adapters/supabase': ['../src/adapters/supabase/index.ts'],
    },
  },
  include: ['snippet_*.ts'],
}, null, 2));

let output = '';
let failed = false;
try {
  execFileSync(join(ROOT, 'node_modules/.bin/tsc'), ['-p', OUT], { encoding: 'utf8', stdio: 'pipe' });
} catch (error) {
  failed = true;
  output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
}

if (failed) {
  // Map "snippet_007.ts(3,5): error ..." back to "docs/guide/x.md:42: error ..."
  const mapped = output.split('\n').map((line) => {
    const match = /(snippet_\d+\.ts)\((\d+),(\d+)\): (.*)$/.exec(line.trim());
    if (!match || !origin.has(match[1])) return line;
    const snippet = origin.get(match[1]);
    return `${relative(ROOT, snippet.file)}:${snippet.line + Number(match[2]) - 1}:${match[3]}: ${match[4]}`;
  });
  console.error(mapped.filter((l) => !l.includes('src/')).join('\n').trim());
  console.error(`\n✗ Doc snippets failed to typecheck (${snippets.length} checked)`);
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
console.log(`✓ ${snippets.length} doc snippets typecheck (${files.length} files)`);
