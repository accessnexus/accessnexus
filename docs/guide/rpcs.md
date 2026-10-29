# RPCs

An RPC is a Postgres function your app calls through Supabase (`supabase.rpc(...)`, or `db.rpc.<name>()` in the generated SDK). You declare it with `rpc()` next to your tables; AccessNexus writes the `CREATE OR REPLACE FUNCTION`, the grants, and a typed client method.

Use an RPC when one table rule is not enough: an aggregate the client should not compute, a multi-step change that must stay consistent, or an action that needs to touch rows the caller cannot see (accepting an invitation, restoring a soft-deleted row).

## Declare an RPC

RPCs are the second argument of `defineSchema`, under `rpcs`. They never go inside the tables object (`validate` reports `RPC_IN_TABLES`).

```ts [accessnexus.schema.ts]
import { defineSchema, policy, rpc, table } from 'accessnexus';

export default defineSchema({
  todos: table({
    columns: { id: 'uuid', user_id: 'uuid', done: 'boolean' },
    primaryKey: 'id',
    references: { user_id: 'auth.users.id' },
    policies: {
      select: policy.isOwner('user_id'),
      insert: policy.isOwner('user_id'),
      update: policy.isOwner('user_id'),
      delete: policy.isOwner('user_id'),
    },
  }),
}, {
  rpcs: {
    count_open_todos: rpc({
      returns: 'int',
      language: 'sql',
      body: 'SELECT count(*)::int FROM todos WHERE user_id = (SELECT auth.uid()) AND NOT done;',
    }),
  },
});
```

`npx accessnexus generate` writes it to `generated/rpcs/rpcs.sql`:

```sql
CREATE OR REPLACE FUNCTION count_open_todos()
RETURNS INTEGER
LANGUAGE sql
SECURITY INVOKER
VOLATILE
SET search_path = pg_catalog, public
AS $$
SELECT count(*)::int FROM todos WHERE user_id = (SELECT auth.uid()) AND NOT done;
$$;
```

`push` applies `rpcs.sql` after migrations, policies and triggers, and re-applies it whenever it changes.

## Three forms

| Form | Generates SQL | Types the client | Use it for |
| --- | --- | --- | --- |
| `rpc({ args, returns, body })` | yes | yes | functions AccessNexus owns |
| `rpc({ args, returns })` | no | yes | a function that already exists in the database (written in a migration you keep) |
| `rpc()` | no | from your `Database` type | [Database mode](/guide/schema), where types come from `database.types.ts` |

Only RPCs with a `body` end up in `rpcs.sql`.

## Options

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `args` | `Record<string, ColumnType>` | none | Argument name to column type (`'uuid'`, `'text'`, `'int'`, `'jsonb'`, `'text[]'`, ...). The order of the keys is the order of the SQL arguments. |
| `returns` | `ColumnType \| 'void'` | `'void'` | A scalar or array column type. There is no `SETOF` / `TABLE` return: return `jsonb` (built with `json_agg` / `json_build_object`) for row sets. |
| `body` | `string` | none | The function body, without the `CREATE FUNCTION` wrapper. |
| `language` | `'plpgsql' \| 'sql'` | `'plpgsql'` | See [Writing the body](#writing-the-body). |
| `security` | `'invoker' \| 'definer'` | `'invoker'` | See [Invoker or definer](#invoker-or-definer). |
| `allowAnon` | `boolean` | `false` | Definer RPCs only: also grant EXECUTE to `anon`. |
| `immutable` | `boolean` | `false` | `true` emits `IMMUTABLE`, otherwise `VOLATILE`. There is no `STABLE` option. |

RPC names follow the same rule as tables: lowercase snake_case (`INVALID_IDENTIFIER` otherwise). Unknown argument types fail with `UNKNOWN_COLUMN_TYPE`.

## Writing the body

- **`plpgsql`**: AccessNexus wraps the body in `BEGIN ... END;`. If your body starts with `DECLARE` or `BEGIN`, it is emitted as-is, so write the whole block yourself (needed for local variables).
- **`sql`**: emitted verbatim. The last statement's result is the return value.
- Every function gets `SET search_path = pg_catalog, public`. Anything outside those two schemas must be schema-qualified (`auth.uid()`, `auth.users`, `extensions.<fn>`).
- `args` become plain SQL parameters. Prefix them (`p_org_id`) so they never shadow a column name.

```ts [accessnexus.schema.ts]
import { defineSchema, rpc, table } from 'accessnexus';

export default defineSchema({
  notes: table({
    columns: { id: 'uuid', user_id: 'uuid', body: 'text' },
    primaryKey: 'id',
    references: { user_id: 'auth.users.id' },
  }),
}, {
  rpcs: {
    // plpgsql with local variables: write the full DECLARE ... BEGIN ... END block
    my_note_stats: rpc({
      returns: 'jsonb',
      body: `
        DECLARE
          v_total int;
        BEGIN
          SELECT count(*) INTO v_total FROM notes WHERE user_id = (SELECT auth.uid());
          RETURN jsonb_build_object('total', v_total);
        END;`,
    }),
  },
});
```

## Invoker or definer

| | `security: 'invoker'` (default) | `security: 'definer'` |
| --- | --- | --- |
| Runs as | the caller | the function owner (the role that ran `push`) |
| RLS inside the body | applies, exactly as for a direct query | bypassed |
| Who can EXECUTE | Supabase's default: `anon` and `authenticated` | `authenticated` and `service_role`; `anon` only with `allowAnon: true` |
| You must | nothing extra: RLS protects the data | check the caller yourself |

Prefer invoker. Reach for definer only when the function must read or write rows the caller's policies hide, for example inserting a membership row into a table whose `insert` policy is `policy.none()`.

For a definer RPC, AccessNexus appends:

```sql
REVOKE EXECUTE ON FUNCTION accept_invitation(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accept_invitation(TEXT) TO authenticated, service_role;
```

With `allowAnon: true` the `REVOKE` keeps `anon` and the `GRANT` adds it:

```sql
REVOKE EXECUTE ON FUNCTION public_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_stats() TO authenticated, service_role, anon;
```

`allowAnon` has no effect on invoker RPCs.

::: danger A definer RPC is a hole in RLS unless you close it
Inside a definer body every table is readable and writable. Anything the arguments let the caller reach, they reach. Before doing anything else, check:

1. **Who is calling.** `(SELECT auth.uid()) IS NULL` means an anonymous caller (or the service role). Reject it unless anonymous use is the point.
2. **That the caller may act on these rows.** Filter by `(SELECT auth.uid())`, or check membership explicitly. Never trust an id passed in `args` as "the current user".
3. **What the result reveals.** Return only what the caller may see.

`validate` does not inspect definer bodies for these checks. It only warns about bare `auth.uid()` calls.
:::

## Check the caller inside a definer function

Raise with SQLSTATE `42501` (insufficient privilege), so the client sees the same class of error as an RLS denial.

```ts [accessnexus.schema.ts]
import { defineSchema, policy, rpc, table } from 'accessnexus';

export default defineSchema({
  orgs: table({
    columns: { id: 'uuid', name: 'text' },
    primaryKey: 'id',
    policies: {
      select: policy.belongsTo('id', { table: 'org_members', foreignKey: 'org_id', localKey: 'user_id' }),
    },
  }),
  org_members: table({
    columns: { id: 'uuid', org_id: 'uuid', user_id: 'uuid', role: "enum('admin','member')" },
    primaryKey: 'id',
    references: { org_id: 'orgs.id', user_id: 'auth.users.id' },
    indexes: [{ columns: ['org_id', 'user_id'], unique: true }],
    policies: {
      select: policy.isOwner('user_id'),
      insert: policy.none(),
      update: policy.none(),
      delete: policy.none(),
    },
  }),
}, {
  rpcs: {
    // Org admins remove a member. org_members has no DELETE rule for anyone,
    // so this definer function is the only way, and it checks everything itself.
    remove_member: rpc({
      args: { p_org_id: 'uuid', p_user_id: 'uuid' },
      security: 'definer',
      body: `
        IF (SELECT auth.uid()) IS NULL THEN
          RAISE EXCEPTION 'sign in first' USING ERRCODE = '42501';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM public.org_members m
          WHERE m.org_id = p_org_id AND m.user_id = (SELECT auth.uid()) AND m.role = 'admin'
        ) THEN
          RAISE EXCEPTION 'only org admins can remove members' USING ERRCODE = '42501';
        END IF;
        DELETE FROM public.org_members WHERE org_id = p_org_id AND user_id = p_user_id;`,
    }),
  },
});
```

The same pattern, with an email-confirmation check, is the `accept_invitation` RPC in the [invitation recipe](/guide/cookbook#invitation-based-membership-consent).

## Wrap auth calls

Always write `(SELECT auth.uid())` and `(SELECT auth.jwt())`, never the bare call. Inside a query, the subquery form is evaluated once (an initPlan) instead of once per row, and it is the form the generator itself emits in policies.

```sql
-- Good
DELETE FROM public.todos WHERE user_id = (SELECT auth.uid());
-- Flagged by validate (UNWRAPPED_AUTH_CALL)
DELETE FROM public.todos WHERE user_id = auth.uid();
```

`validate` warns `UNWRAPPED_AUTH_CALL` for a bare `auth.uid()`, `auth.jwt()` or `auth.role()` in an RPC body, in `policy.custom()`, and in a `trigger.lockColumns({ unless })` condition.

## Call it from the SDK

Each RPC becomes a typed method under `db.rpc`. The result is `{ data, error }`, as in supabase-js, and the call runs as the signed-in user.

```ts [src/dashboard.ts]
import { createClient } from '@supabase/supabase-js';
import { createAccessNexusClient } from './generated/sdk/client.js';

const db = createAccessNexusClient(createClient('https://xyz.supabase.co', 'public-anon-key'));

export async function loadDashboard() {
  // RPC without args: pass an empty object
  const { data: open, error } = await db.rpc.count_open_todos({});
  if (error) throw error;
  return open; // number
}
```

Argument and return types come from the column types: `uuid`/`text` become `string`, `int`/`bigint`/`float` become `number`, `jsonb` becomes `Record<string, unknown>`. A plain supabase-js call (`supabase.rpc('count_open_todos')`) reaches the same function.

## Changing or removing an RPC

`push` re-runs `rpcs.sql` with `CREATE OR REPLACE FUNCTION`, which has Postgres' limits:

| Change in the schema | What happens in the database |
| --- | --- |
| Body, language, security | Replaced in place. |
| Return type | `push` fails with `PUSH_FAILED` (Postgres cannot change a function's return type). Drop the old function by hand, then push. |
| Argument types or count | A **new** function (overload) is created. The old one stays, with its old grants. |
| RPC removed from the schema | The function stays in the database. AccessNexus never drops functions. |

::: warning Drop old definer functions yourself
After you change a definer RPC's arguments or remove it, the previous version is still callable by `authenticated`. Drop it explicitly (`DROP FUNCTION old_name(uuid);` as `postgres`) if it should no longer exist.
:::

## Related

- [Security model](/guide/security): what the generator guarantees and what definer code must do
- [Examples](/guide/cookbook): invitations, restore after soft delete
- [Triggers](/guide/triggers): `security: 'definer'` triggers follow the same rules
- [`rpc()` API reference](/api/rpc)
- [Generated SDK](/api/sdk)
