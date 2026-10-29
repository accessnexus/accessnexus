# AGENTS.md

Operating guide for **any AI coding agent** working in this repository
(Claude Code, Gemini CLI, Codex, Cursor, Copilot, etc.). Read this before editing.

---

## 🚫 Hard rule: no AI attribution in commits

**Never add any AI/agent co-author or attribution to commits or PRs.**

Specifically, do **NOT**:

- add `Co-Authored-By: Claude ...`, `Co-Authored-By: Gemini ...`, `Co-Authored-By: Codex ...`,
  or any AI/bot/agent trailer;
- add "Generated with", "Co-authored with AI", "🤖" or similar markers to commit messages,
  PR titles, or PR bodies;
- set the commit `author` or `committer` to an AI/bot identity.

Commits are authored solely by the human maintainer. Write a normal Conventional Commits
message and stop — no attribution footer of any kind.

> If a tool adds such a trailer automatically, remove it before committing.

---

## Project

> This file is for agents **contributing to AccessNexus itself**. The agent reference for projects
> that *use* AccessNexus is `llms.txt` (shipped in the npm package) plus the block `accessnexus init`
> writes into the user's own `AGENTS.md` (`src/cli/init/agents.ts`). Keep `llms.txt` true
> whenever you change the public API, CLI flags, error codes or `--json` shapes.

**AccessNexus** — a schema-first engine for Supabase, published as **`accessnexus`**. You define your data
model and access rules in TypeScript; AccessNexus generates migrations (DDL), RLS policies, RBAC,
triggers, PostgreSQL functions/RPCs, and a typed client SDK.

The hard problem this repo solves is **correct RLS**: the generated SQL must be secure and
performant. Treat the RLS/permission generators as the crown jewels.

Public runtime API (from `src/index.ts`): `defineSchema`, `table`, `policy`, `definePermissions`,
`trigger`, `rpc`, `defineSeed`, `defineConfig`, `SupabaseAdapter`. Two schema modes: **manual**
(explicit `columns`) and **Database mode** (columns inferred from a Supabase `Database` type —
detected when no table declares `columns`).

## Layout

```
src/
  core/          # schema/policy/permissions/trigger/rpc/seed builders + types
    policy/      # 11 policy.* builders: isAuthenticated, public, none, isOwner, hasRole,
                 #   belongsTo, matchesField, custom, any, all, withCheck
  adapters/      # DB adapters — supabase only. Adapter contract in core/types.
  cli/           # CLI: index.ts (bin) → run.ts (commands, --json, exit codes), schema-check.ts
                 #   (static checks), destructive.ts, diff.ts, migrations.ts, init/
  __tests__/     # vitest suites: source of truth for generator + CLI behavior
                 #   (push.integration.test.ts runs only with ACCESSNEXUS_TEST_DB_URL)
examples/        # fullstack-saas.schema.ts + seed — reference schema exercising all features
generated/       # committed generated output (migrations, policies, triggers, rpcs, sdk)
docs/            # landing page (index.html); private notes in docs/ are gitignored
llms.txt         # agent reference shipped to users (every ts snippet must typecheck)
dist/            # build output — NOT committed (built by `prepare` / `prepublishOnly`)
```

Single package: all code lives in root `src/`, published as `accessnexus`.
Published bin: `accessnexus` → `dist/cli/index.js`. ESM (`type: module`) — use explicit `.js`
import specifiers in source. Runtime deps are lean: `esbuild` (loads the user's `.ts` schema),
`@supabase/supabase-js` (optional peer) and `pg` (optional peer, dynamically imported, only for
`push`/`seed`). Never commit `dist/` or build output inside `src/` (both are gitignored).

## Commands

```bash
npm install                 # install deps (prepare also builds dist/)
npx vitest run              # run the suite (must stay green)
npm run generate:example    # build + regenerate generated/ from accessnexus.config.ts (example schema)
node dist/cli/index.js <cmd>  # CLI from a build: init | generate | diff | push | seed | validate | help
npm run build               # clean tsc build to dist/
npm run typecheck           # tsc --noEmit for src/ and examples/
# Integration tests against a real Supabase Postgres (see the file header for the docker setup):
ACCESSNEXUS_TEST_DB_URL=postgres://postgres:postgres@127.0.0.1:55439/postgres npx vitest run push.integration
```

## Working rules

- **Tests are the contract.** Any change to a generator must be covered by / reconciled with
  `src/__tests__/*`. Run `npx vitest run` before finishing. Never disable or `--watchAll` in CI.
- **`generated/` is derived.** Do not hand-edit files under `generated/`. Change the generator,
  then run `npm run generate:example`. This repo's `accessnexus.config.ts` sets
  `adapterOptions.deterministic: true`, so its output has no `Generated at:` line and is
  byte-stable; with the default (`false`) the header carries a timestamp, which `generate`,
  `diff` and `push` strip before comparing / hashing. Keep the SQL body deterministic; don't
  introduce nondeterminism (ordering, random ids) into the body.
- **RLS correctness is non-negotiable.** Preserve these patterns when touching policy SQL:
  - `(SELECT auth.uid())` wrapped in a subquery (initPlan performance);
  - `SECURITY DEFINER` + `SET search_path = pg_catalog, public` on helper functions;
  - `ENABLE` **and** `FORCE ROW LEVEL SECURITY` on every table — a table without policies is
    deny-all (fail closed); only an explicit `enableRLS: false` skips RLS;
  - separate `USING` (read) vs `WITH CHECK` (write); UPDATE always has an explicit `WITH CHECK`,
    and `policy.withCheck` keeps `using` in it unless `mode: 'replace'`;
  - self-referential membership checks via `SECURITY DEFINER` functions (avoids RLS recursion),
    with EXECUTE revoked from `PUBLIC`/`anon`;
  - audit and soft-delete trigger functions are `SECURITY DEFINER` with a pinned search_path and
    schema-qualified targets; the soft-delete guard keeps API users from setting/clearing the
    soft-delete column with UPDATE (only DELETE, judged by the DELETE policy, does it);
  - `security: 'definer'` RPCs get `REVOKE EXECUTE ... FROM PUBLIC, anon` unless `allowAnon`;
  - a `select` policy is `TO public` only when a branch can pass without a user; writes are
    `TO public` only for an explicit `policy.public()`;
  - `init --db-url` imports policies fail-closed (roles, RESTRICTIVE, RLS-on-without-policies);
    it must never emit `policy.public()` for a policy that was not granted to `public`;
  - every interpolated string literal goes through `quoteLiteral`; identifiers are validated
    (snake_case, not reserved) by `schema-check.ts` because they are emitted unquoted;
  - `definePermissions` write pins (`pinOwnerOnCreate`, `pinTenant`) stay on by default.
- **Regression guard:** never emit a bare `auth.uid()` / `auth.jwt()` in policy SQL — always
  `(SELECT auth.uid())` (`wrapAuthCall` in the adapter; `UNWRAPPED_AUTH_CALL` warns on custom SQL
  and RPC bodies).
- **CLI contract (users are mostly coding agents):** `--json` prints exactly one JSON object;
  exit codes 0 / 1 (user-fixable) / 2 (internal); errors are `CliError(code, message, { hint })`
  with no stack trace unless `--verbose`/`DEBUG=accessnexus`; nothing prompts without a TTY.
  New error codes, flags or JSON fields must be documented in `llms.txt` and covered by tests.
- **TypeScript, ESM.** `type: module`, explicit `.js` import specifiers in source. Match the
  surrounding style; no new deps without reason (runtime stays lean — `@supabase/supabase-js`
  is a peer dep).
- **Commit style:** Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`),
  imperative subject ≤ ~72 chars. English. And — per the hard rule above — no AI attribution.

## Definition of done

1. `npx vitest run` green (and the integration tests, when the change touches SQL or `push`).
2. If a generator changed: `npm run generate:example` run, `generated/` diff reviewed (only
   intended SQL changes).
3. `npm run typecheck` clean; `npm run build` and `npm pack --dry-run` succeed.
4. Docs still true: `README.md`, `llms.txt` (snippets typecheck), `CHANGELOG.md`.
5. Commit message follows Conventional Commits with **no AI co-author / attribution**.
