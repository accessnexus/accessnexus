# Built for AI coding agents

Most AccessNexus users never type its commands themselves: they ask Claude Code, Cursor, Codex or another coding agent to "add a comments table only the author can edit", and the agent edits the schema and runs the CLI. AccessNexus is designed around that: the agent gets a complete reference, a predictable command contract, and errors it can act on without guessing.

## What the agent reads

### `llms.txt`, shipped in the package

Every install includes `node_modules/accessnexus/llms.txt`: the complete agent reference, versioned with the package you installed. It covers the mental model, the standard workflow, the full API with examples that typecheck against the source, recipes (owner-only, public read, multi-tenant with roles, child of a tenant resource, column-scoped updates, audit log), the RLS rules agents must not break, the `--json` output shapes and every error code with its fix.

Because it lives in `node_modules`, the agent always reads the reference for the installed version, not a web page that may be ahead or behind.

### The `AGENTS.md` block

`init` writes a short block into the project's `AGENTS.md`, the instructions file read by Codex, Cursor, Gemini CLI, Copilot and others. It tells any agent, before it touches the database:

- `accessnexus.schema.ts` is the single source of truth: never write SQL migrations or policies by hand, never edit generated files;
- after every schema change, run `validate` → `diff` → `generate`, in that order;
- `push` changes the real database: before any push, run `diff --against-db --json` (or `push --dry-run --json`) and review `riskyChanges` with the user; push only when the user asked, and never add `--allow-destructive` or `--seed` without the user's explicit OK;
- every table the app uses needs policies; use `policy.none()` to block an operation and never `enableRLS: false`;
- org/team roles are `{ scope: 'tenant', roles }`; `policy.hasRole` is a global app role;
- prefer semantic builders over `policy.custom`, and always write `(SELECT auth.uid())`;
- what exit codes 0, 1 and 2 mean.

The block sits between markers, so it can be updated without touching the rest of the file:

```md [AGENTS.md]
# AGENTS.md

<!-- accessnexus:start -->
## Database: AccessNexus (accessnexus)

This project's Supabase database — tables, columns, RLS policies, roles, triggers and
RPCs — is defined in TypeScript in `accessnexus.schema.ts` and compiled to SQL by AccessNexus.
Full reference for agents (API, recipes, error codes): `node_modules/accessnexus/llms.txt`.
Read it before changing anything database-related.
...
<!-- accessnexus:end -->
```

| Behavior | Details |
| --- | --- |
| Idempotent | Re-running `init` replaces the content between the markers in place; everything outside them is preserved byte for byte. A second run reports `"agentsMd": "unchanged"` |
| No `AGENTS.md` yet | `init` creates it with the block |
| `CLAUDE.md` exists | `init` appends a one-line pointer: *"Database work (Supabase tables, RLS policies, triggers, RPCs) goes through AccessNexus — read the AccessNexus section of @AGENTS.md first."* It never creates `CLAUDE.md` |
| Opt out | `init --no-agents` skips both files |

## The command contract

### Never blocks on a prompt

Without a TTY, every command runs non-interactively. The only command that asks questions is `init`, and without a TTY it refuses instead of hanging:

```json
{
  "ok": false,
  "command": "init",
  "version": "0.1.6",
  "error": {
    "code": "INIT_NOT_INTERACTIVE",
    "message": "init asks questions, but there is no terminal to answer them (stdin is not a TTY)",
    "hint": "Re-run with --yes to accept the defaults, e.g. `npx accessnexus init --yes --no-introspect`. Optional: --sdk <dir>, --src <dir>, --prefix <name>, --db-url <url>, --install, --force, --no-agents."
  }
}
```

`init --yes` accepts the defaults, even in an empty folder. Every choice it would ask about has a flag: `--src`, `--sdk`, `--prefix`, `--db-url`, `--no-introspect`, `--install`, `--force`, `--no-agents`.

Database connections (`push`, `seed`, `init --db-url`) also never hang: they fail with `DB_CONNECTION_FAILED` after 10 seconds (`ACCESSNEXUS_DB_CONNECT_TIMEOUT=<seconds>` to change it).

### `--json`: one object on stdout

Every command accepts `--json` and then prints **exactly one JSON object** on stdout: no progress text, no colors. That includes `help --json` and `<command> --help --json`. Every result has `ok`, `command` and `version`; failures add `error` and keep any partial result (`issues`, `applied`).

```bash
npx accessnexus validate --json
```

```json
{
  "ok": true,
  "command": "validate",
  "version": "0.1.6",
  "schemaPath": "./accessnexus.schema.ts",
  "mode": "manual",
  "tables": [
    {
      "name": "notes",
      "columns": 5,
      "primaryKey": "id",
      "rls": true,
      "policies": ["select", "insert", "update", "delete"],
      "triggers": [{ "kind": "updated_at", "name": null }]
    }
  ],
  "rpcs": [],
  "issues": [],
  "summary": { "errors": 0, "warnings": 0 }
}
```

The full shape of every result is in the [CLI reference](/api/cli).

### Exit codes

| Code | Meaning | What the agent should do |
| --- | --- | --- |
| `0` | Success | Continue |
| `1` | User-fixable error: bad flag, schema error, missing URL, stale output, destructive migration without consent | Read `error.code` and `error.hint`, fix, retry |
| `2` | Internal error (an AccessNexus bug) | Stop, rerun with `--verbose`, report the stack |

Stack traces appear only with `--verbose` or `DEBUG=accessnexus`.

### Actionable errors

Every error has a stable `code`, a message and a hint. In the terminal the hint is printed as `Fix:`; in JSON it is `error.hint`:

```
✗ Unknown flag "--jsn" for `validate` [UNKNOWN_FLAG]

  Fix: Did you mean --json? Run `npx accessnexus validate --help` for all flags.
```

Unknown commands and flags are errors with a did-you-mean hint, never silently ignored. Schema problems fail with `SCHEMA_VALIDATION_FAILED` and list each problem in `issues[]`, with the exact path to change:

```json
{
  "severity": "error",
  "code": "UNKNOWN_COLUMN",
  "path": "tasks.policies.insert",
  "message": "policy.isOwner column \"usr_id\" is not a column of \"tasks\"",
  "hint": "Use one of: id, org_id, user_id, status — or add \"usr_id\" to tasks.columns."
}
```

Warnings are returned with `"severity": "warning"`. Several of them flag security holes (`PUBLIC_WRITE`, `USER_ROW_INSERT_OPEN`, `TENANT_PARENT_UNCHECKED`, `RLS_DISABLED`), so treat them as bugs unless the user asked for that behavior. See [Errors](/api/errors) for every code.

## The recommended agent loop

```bash
# 1. Edit accessnexus.schema.ts (never the generated SQL)

# 2. Static checks: fix every issue with severity "error", treat warnings as bugs
npx accessnexus validate --json

# 3. Review the SQL that will change. Run it BEFORE generate:
#    it compares the schema with the files on disk
npx accessnexus diff --json

# 4. Write the SQL and the SDK (created / updated / unchanged per file)
npx accessnexus generate --json

# 5. What push would REALLY change in the live database: rehearsed in a
#    rolled-back transaction, nothing persists. Review riskyChanges with the user.
npx accessnexus diff --against-db --json     # or: push --dry-run --json (livePlan)

# 6. Apply only when the user asked for it
npx accessnexus push --json
```

`diff --json` (step 3) compares the schema with the generated files; it cannot see what is in the database. `diff --against-db` does: it lists every table, column, policy, trigger, function and grant that would be added, removed or modified, with `before`/`after`, and flags `riskyChanges` such as a function going from `STABLE` to `VOLATILE`, a lost `SET search_path`, a policy widened from `authenticated` to `public`, a dropped policy or a lost column default. An agent should show these to the user before pushing. A push Postgres would reject comes back as `PUSH_WOULD_FAIL` with the file and the SQL error, and nothing was persisted.

::: warning Stop and ask the user
If `diff --against-db` reports `riskyChanges` or `blockers`, or `generate`, `diff` or `push --dry-run` reports `destructive` statements, the agent must tell the user what data would be lost and wait. `--allow-destructive` and `--seed` need the user's explicit OK. A rename belongs in the schema as a rename, not as remove + add.
:::

In CI, `npx accessnexus diff --check` exits `1` when someone changed the schema without regenerating.

::: danger Fixing a permission error the wrong way
When the app gets an RLS error or an empty result, an agent may be tempted to "fix" it by removing policies, adding `enableRLS: false` or using `policy.public()` for a write. All three open the table. The fix is a correct rule: for example, a `select` rule that also admits rows the user just inserted, since the SDK's `create` returns the row. The full list of rules is in `llms.txt` under "RLS rules agents must not break" and in the [Security model](/guide/security).
:::

## A prompt to give your agent

Paste this into Claude Code, Cursor or Codex at the start of a database task:

```text
This project uses AccessNexus for its Supabase database. Before changing anything
database-related, read node_modules/accessnexus/llms.txt and the AccessNexus block in AGENTS.md.

Task: add a `comments` table. Each comment belongs to a post and has an author.
Anyone who can read the post can read its comments; only the author can edit or delete
their comment, and nobody can change a comment's post or author after creating it.

Rules:
- Change only accessnexus.schema.ts. Never edit generated SQL.
- Run `npx accessnexus validate --json`, then `diff --json`, then `generate --json`.
  Fix every error and explain every warning you keep.
- Run `npx accessnexus diff --against-db --json` and show me the changes and
  riskyChanges. Do not push,
  do not use --allow-destructive or --seed, until I say so.
- Summarize the access rules you wrote in plain English.
```

Asking for a plain-English summary of the rules is the cheapest review you can do without reading SQL.

## Next steps

- [Quick start](/guide/quick-start) - the same loop, by hand
- [CLI](/guide/cli) - every command and flag
- [Errors](/api/errors) - every error and issue code, with fixes
- [Security model](/guide/security) - what the generated SQL guarantees
