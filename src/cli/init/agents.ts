// ============================================
// AccessNexus - Agent instructions written by `init`
// Puts a marked, idempotent block into the project's AGENTS.md (read by Codex,
// Cursor, Gemini CLI, Copilot...) and a one-line pointer into CLAUDE.md, so
// coding agents learn the AccessNexus workflow before touching the database.
// ============================================

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const AGENTS_BLOCK_START = '<!-- accessnexus:start -->';
export const AGENTS_BLOCK_END = '<!-- accessnexus:end -->';
export const CLAUDE_POINTER =
  'Database work (Supabase tables, RLS policies, triggers, RPCs) goes through AccessNexus — read the AccessNexus section of @AGENTS.md first.';

export interface AgentsBlockOptions {
  /** Schema file, relative to the project root (e.g. `accessnexus.schema.ts`). */
  schemaPath: string;
  /** Typed SDK folder, relative to the project root (e.g. `src/lib/accessnexus`). */
  sdkPath: string;
  /** Base folder for generated SQL (e.g. `generated`). */
  generatedDir: string;
}

export type FileAction = 'created' | 'updated' | 'unchanged';

/** The marked block, including the start/end markers. */
export function renderAgentsBlock(options: AgentsBlockOptions): string {
  const { schemaPath, sdkPath, generatedDir } = options;
  return `${AGENTS_BLOCK_START}
## Database: AccessNexus (accessnexus)

This project's Supabase database — tables, columns, RLS policies, roles, triggers and
RPCs — is defined in TypeScript in \`${schemaPath}\` and compiled to SQL by AccessNexus.
Full reference for agents (API, recipes, error codes): \`node_modules/accessnexus/llms.txt\`.
Read it before changing anything database-related.

Rules:
- \`${schemaPath}\` is the single source of truth. Never write SQL migrations or RLS
  policies by hand, and never edit generated files (\`${generatedDir}/\`, \`${sdkPath}/client.ts\`,
  \`${sdkPath}/types.ts\`) — change the schema and regenerate. The client wrapper(s) init wrote
  in \`${sdkPath}/\` (index.ts, or server.ts/browser.ts) are yours: edit env var names freely.
- After every schema change run, in order:
  1. \`npx accessnexus validate --json\` — fix every issue with severity "error"
  2. \`npx accessnexus diff --json\` — review the SQL that will change (before generate:
     diff compares the schema with the files on disk, so it is empty right after generate)
  3. \`npx accessnexus generate --json\` — writes the SQL and the SDK
- \`npx accessnexus push\` changes the real database. Run \`npx accessnexus push --dry-run --json\`
  first and only push when the user asked for it. Never add \`--allow-destructive\` (drops
  tables/columns) or \`--seed\` without the user's explicit OK.
- Every table the app reads or writes must have \`policies\` for select/insert/update/delete.
  No policies = deny-all (the client gets nothing). Use \`policy.none()\` to block an
  operation; never add \`enableRLS: false\` (it opens the table to anyone with the anon key).
- Roles inside an org/team: \`{ scope: 'tenant', roles: [...] }\` in \`definePermissions\`.
  \`policy.hasRole\` and role arrays are global app roles (JWT \`app_metadata.role\`).
- Prefer \`policy.isOwner\`, \`policy.belongsTo\` (with a membership table) and \`definePermissions\`
  over \`policy.custom\`;
  in custom SQL always write \`(SELECT auth.uid())\`, never a bare \`auth.uid()\`.
- Exit codes: 0 ok, 1 fixable error (read \`error.code\`, \`error.message\`, \`error.hint\` in the
  JSON), 2 AccessNexus bug (stop and report it).
${AGENTS_BLOCK_END}`;
}

/**
 * Insert or replace the AccessNexus block in `existing` (the current AGENTS.md text,
 * or `undefined` when the file does not exist). Content outside the markers is
 * preserved byte-for-byte. Running it twice yields the same text.
 */
export function upsertAgentsBlock(existing: string | undefined, block: string): string {
  if (existing === undefined || existing.trim().length === 0) {
    return `# AGENTS.md\n\n${block}\n`;
  }

  const start = existing.indexOf(AGENTS_BLOCK_START);
  const end = existing.indexOf(AGENTS_BLOCK_END, start);
  if (start !== -1 && end !== -1) {
    return existing.slice(0, start) + block + existing.slice(end + AGENTS_BLOCK_END.length);
  }

  const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${separator}${block}\n`;
}

/** Add the one-line AGENTS.md pointer to CLAUDE.md text (no-op if already present). */
export function ensureClaudePointer(existing: string): string {
  if (existing.includes(CLAUDE_POINTER)) return existing;
  const separator = existing.length === 0 || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${separator}${CLAUDE_POINTER}\n`;
}

/**
 * Write the agent instructions into `projectRoot`:
 * - AGENTS.md: created, or its AccessNexus block inserted/replaced;
 * - CLAUDE.md: only if it already exists, gets a one-line pointer to AGENTS.md.
 */
export function writeAgentInstructions(
  projectRoot: string,
  options: AgentsBlockOptions,
): { agentsMd: FileAction; claudeMd: FileAction | 'absent' } {
  const agentsPath = join(projectRoot, 'AGENTS.md');
  const current = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf-8') : undefined;
  const next = upsertAgentsBlock(current, renderAgentsBlock(options));
  let agentsMd: FileAction = 'unchanged';
  if (next !== current) {
    writeFileSync(agentsPath, next, 'utf-8');
    agentsMd = current === undefined ? 'created' : 'updated';
  }

  const claudePath = join(projectRoot, 'CLAUDE.md');
  let claudeMd: FileAction | 'absent' = 'absent';
  if (existsSync(claudePath)) {
    const claudeCurrent = readFileSync(claudePath, 'utf-8');
    const claudeNext = ensureClaudePointer(claudeCurrent);
    claudeMd = 'unchanged';
    if (claudeNext !== claudeCurrent) {
      writeFileSync(claudePath, claudeNext, 'utf-8');
      claudeMd = 'updated';
    }
  }

  return { agentsMd, claudeMd };
}
