---
layout: home

hero:
  name: AccessNexus
  text: Row-level security you can trust
  tagline: Define tables and access rules in TypeScript. Get correct RLS, RBAC, migrations and a typed SDK for Supabase — in a form your AI coding agent can't get wrong.
  actions:
    - theme: brand
      text: Quick start
      link: /guide/quick-start
    - theme: alt
      text: Why AccessNexus
      link: /guide/introduction
    - theme: alt
      text: GitHub
      link: https://github.com/accessnexus/accessnexus

features:
  - title: Access rules as code
    details: One schema file is the source of truth for tables, policies, roles, triggers and RPCs. Rules live next to the data model instead of scattered across SQL migrations.
    link: /guide/schema
    linkText: Model a schema
  - title: Secure by default
    details: ENABLE + FORCE RLS on every table, deny-all when no rule exists, separate USING and WITH CHECK, write pins on owner and tenant columns, hardened SECURITY DEFINER helpers.
    link: /guide/security
    linkText: Security model
  - title: Multi-tenant RBAC
    details: definePermissions turns org/team membership and roles into policies — with recursion-safe membership checks and no self-promotion paths.
    link: /guide/permissions
    linkText: Permissions & tenants
  - title: Fast policies
    details: Auth calls are wrapped as (SELECT auth.uid()) so Postgres evaluates them once per query, and policy columns get indexes automatically.
    link: /guide/how-it-works
    linkText: How it works
  - title: Built for AI agents
    details: Ships llms.txt, writes an AGENTS.md block, never prompts without a TTY, prints one JSON object with --json and fails with a code and a fix hint.
    link: /guide/ai-agents
    linkText: Agent workflow
  - title: Validate before you push
    details: Static checks catch unknown columns, open writes, impersonation, cross-tenant holes and typos before any SQL reaches the database. Pushes are drift-checked.
    link: /guide/cli
    linkText: CLI tour
---

## From schema to secure database in four commands

```bash
npx accessnexus init --yes
```

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table, trigger } from 'accessnexus';

export default defineSchema({
  notes: table({
    columns: {
      id: 'uuid',
      user_id: 'uuid',
      body: 'text',
      created_at: { type: 'timestamptz', default: 'now()' },
      updated_at: 'timestamptz?',
    },
    primaryKey: 'id',
    references: { user_id: 'auth.users.id' },
    indexes: [{ columns: ['user_id'] }],
    triggers: [trigger.updatedAt('updated_at')],
    policies: {
      select: policy.isOwner('user_id'),
      insert: policy.isOwner('user_id'),
      update: policy.isOwner('user_id'),
      delete: policy.isOwner('user_id'),
    },
  }),
});
```

```bash
npx accessnexus validate   # static checks: columns, rules, security pitfalls
npx accessnexus generate   # migrations, RLS policies, triggers, RPCs, typed SDK
npx accessnexus push       # apply to your Supabase database, drift-checked
```

Each user now reads and writes only their own notes — enforced by Postgres, not by your app code.

## Let your agent do it

Tell Claude Code, Cursor or Codex:

> Use AccessNexus (read `node_modules/accessnexus/llms.txt`). Add a `projects` table where org members can read, admins can create and update, and only the owner can delete. Run `validate --json` until it is clean, then `generate`.

The package ships a complete agent reference, and `init` writes the rules your agent must follow into your project's `AGENTS.md`. See [Built for AI agents](/guide/ai-agents).
