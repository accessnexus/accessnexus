# rpc

Define a Postgres function, exposed through Supabase as an RPC and typed in the SDK as `client.rpc.<name>()`. Guide: [RPCs](/guide/rpcs).

```ts
function rpc(config?: {
  args?: Record<string, ColumnType>;
  returns?: RpcReturnType;
  body?: string;
  language?: RpcLanguage;
  security?: RpcSecurity;
  volatility?: RpcVolatility;
  immutable?: boolean; // alias of volatility: 'immutable'
  set?: Record<string, string>;
  allowAnon?: boolean;
}): RpcDef;
```

RPCs are passed in the second argument of [`defineSchema`](/api/schema#defineschema): `defineSchema(tables, { rpcs: { name: rpc({...}) } })`. Putting one among the tables is reported as `RPC_IN_TABLES`. RPC names must be lowercase snake_case (`INVALID_IDENTIFIER`).

## Usage modes

| Call | SQL generated | SDK |
| --- | --- | --- |
| `rpc()` | none | `rpc.<name>(args)` typed from `Database['public']['Functions']` (Database mode) |
| `rpc({ args, returns })` | none | typed from `args` / `returns` (the function already exists in the database) |
| `rpc({ args?, returns?, body, ... })` | `CREATE OR REPLACE FUNCTION` in `rpcs.sql` | typed from `args` / `returns` |

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `args` | `Record<string, ColumnType \| { type, default? }>` | `{}` | Argument name to type, in declaration order. Types as in [column types](/api/schema#column-types); a trailing `?` only affects the TS type. `{ type: 'int', default: '20' }` emits `DEFAULT 20` (raw SQL) and makes the argument optional in the client; every argument after one with a default needs one too. |
| `returns` | `ColumnType \| 'void' \| { table } \| { setof }` | `'void'` | Return type. Omitted: `RETURNS VOID` in SQL, `unknown` in the SDK. See [Return types](#return-types) for row sets. |
| `body` | `string` | `undefined` | Function body without the `CREATE FUNCTION` wrapper. Without it no SQL is generated. |
| `language` | `'plpgsql' \| 'sql'` | `'plpgsql'` | `LANGUAGE`. |
| `security` | `'invoker' \| 'definer'` | `'invoker'` | `SECURITY INVOKER` or `SECURITY DEFINER`. |
| `volatility` | `'volatile' \| 'stable' \| 'immutable'` | `'volatile'` | `VOLATILE`, `STABLE` or `IMMUTABLE`. Use `'stable'` for read-only functions called from RLS policies (see below). |
| `immutable` | `boolean` | `false` | Alias of `volatility: 'immutable'`. Combining it with a different `volatility` is `RPC_VOLATILITY_CONFLICT`. |
| `set` | `Record<string, string>` | `undefined` | Function configuration: `{ row_security: 'off' }` emits `SET row_security = 'off'`. Keys must be configuration parameter names (`work_mem`, `myapp.tenant`), values are strings emitted as one quoted literal (`INVALID_FUNCTION_SET` otherwise). `search_path` cannot be changed: a different value is ignored with a `SEARCH_PATH_PINNED` warning. |
| `allowAnon` | `boolean` | `false` | `security: 'definer'` only: keep `EXECUTE` for `anon`. |

Unknown argument types are reported as `UNKNOWN_COLUMN_TYPE`; a bare `auth.uid()` in the body as `UNWRAPPED_AUTH_CALL`.

::: tip Volatility and RLS
A function called inside a policy (`policy.custom('is_member(org_id)')`) that is `VOLATILE` is evaluated again for every row, and Postgres cannot hoist it into an initPlan. Declare read-only helpers `volatility: 'stable'` (or `'immutable'` when the result depends only on the arguments) so they can be evaluated once per query.
:::

::: warning
Enum types (`"enum('a','b')"`) are accepted by `validate` for `args` and `returns` but are emitted literally into the SQL signature, which Postgres rejects. Use `'text'` and cast inside the body.
:::

## Return types

| `returns` | SQL | SDK `Returns` |
| --- | --- | --- |
| `'int'`, `'jsonb'`, ... (a column type) | `RETURNS INT` | the column's TS type (`number`, `Json`, ...) |
| `'void'` or omitted | `RETURNS VOID` | `unknown` |
| `{ table: { booking_id: 'uuid', date_time: 'timestamptz', services: 'json', has_review: 'boolean' } }` | `RETURNS TABLE(booking_id UUID, date_time TIMESTAMPTZ, services JSON, has_review BOOLEAN)` | `{ booking_id: string; date_time: string; services: Json; has_review: boolean }[]` |
| `{ setof: 'bookings' }` (a table of the schema) | `RETURNS SETOF bookings` | `Bookings[]` (that table's Row) |
| `{ setof: 'uuid' }` (a column type) | `RETURNS SETOF UUID` | `string[]` |

`table` columns map to TS like table columns (`json`/`jsonb` → `Json`, `timestamptz`/`date` → `string`, `int`/`numeric` → `number`); a nullable type such as `'text?'` gives `string | null`. The array shape is the same one `supabase gen types` produces. Result column names must be valid identifiers (`INVALID_IDENTIFIER`) and their types known (`UNKNOWN_COLUMN_TYPE`); an unknown return type, an empty `table`, a `setof` that is neither a schema table nor a column type, or any other shape is `INVALID_RPC_RETURNS`.

## Generated SQL

```sql
CREATE OR REPLACE FUNCTION <name>(<arg> <TYPE>, ...)
RETURNS <TYPE>
LANGUAGE <language>
SECURITY <INVOKER|DEFINER>
<VOLATILE|STABLE|IMMUTABLE>
SET search_path = pg_catalog, public
SET <key> = '<value>'   -- one per `set` entry, sorted by key
AS $$
<body>
$$;
```

With `language: 'plpgsql'`, a body that does not start with `DECLARE` or `BEGIN` is wrapped in `BEGIN ... END;`. With `language: 'sql'`, or a body that starts with `DECLARE` / `BEGIN`, it is emitted as written.

Each function is preceded by a `DO $$ ... $$` guard: when a function with that name and argument types already exists with different argument names or a different result type (scalar, `TABLE` columns or `SETOF`), it runs `DROP FUNCTION <name>(<argtypes>)` (no `CASCADE`) so the `CREATE OR REPLACE` can succeed. An unchanged function is never dropped. See [Changing or removing an RPC](/guide/rpcs#changing-or-removing-an-rpc).

## Security and grants

| `security` | `allowAnon` | Grants emitted | Callable by |
| --- | --- | --- | --- |
| `'invoker'` | ignored | none | Supabase default for new public functions (`anon`, `authenticated`, `service_role`). RLS applies inside. |
| `'definer'` | `false` | `REVOKE EXECUTE ON FUNCTION <name>(<types>) FROM PUBLIC, anon;` `GRANT EXECUTE ... TO authenticated, service_role;` | signed-in users and the service role |
| `'definer'` | `true` | `REVOKE ... FROM PUBLIC;` `GRANT ... TO authenticated, service_role, anon;` | everyone |

::: warning
A `SECURITY DEFINER` function runs as its owner and bypasses RLS. Check the caller inside the body (`(SELECT auth.uid())`, reject `NULL` for anonymous callers) and schema-qualify tables (`public.todos`). Use `allowAnon: true` only for functions that are safe for anyone holding the anon key.
:::

`init --db-url` sets `allowAnon: true` (with a `// NOTE:` comment) on every imported definer function that `anon` could execute in the source database, directly or through `PUBLIC`, so the import does not take access away; it lists them in `anonExecutableFunctions`. There is no option to withhold `EXECUTE` from `authenticated`: an imported definer function that `authenticated` could not execute is granted it, with a `// NOTE:` and an entry in `authenticatedGrantedFunctions` (`diff --against-db` reports it as `grant_widened`).

## Example

```ts
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
    // SQL function, invoker: RLS applies
    count_open_todos: rpc({
      returns: 'int',
      language: 'sql',
      body: 'SELECT count(*)::int FROM todos WHERE user_id = (SELECT auth.uid()) AND NOT done;',
    }),
    // PL/pgSQL with an argument; wrapped in BEGIN ... END
    complete_all: rpc({
      args: { p_user: 'uuid' },
      body: 'UPDATE todos SET done = true WHERE user_id = p_user AND p_user = (SELECT auth.uid());',
    }),
    // Definer: bypasses RLS, so it checks the caller first
    reset_my_todos: rpc({
      security: 'definer',
      body: `IF (SELECT auth.uid()) IS NULL THEN RAISE EXCEPTION 'sign in first' USING ERRCODE = '42501'; END IF;
             DELETE FROM public.todos WHERE user_id = (SELECT auth.uid());`,
    }),
    // Row set: RETURNS TABLE(...), SDK { id: string; done: boolean }[]
    my_todos: rpc({
      returns: { table: { id: 'uuid', done: 'boolean' } },
      language: 'sql',
      volatility: 'stable',
      body: 'SELECT id, done FROM todos WHERE user_id = (SELECT auth.uid());',
    }),
    // RETURNS SETOF todos, SDK Todos[]
    open_todos: rpc({
      returns: { setof: 'todos' },
      language: 'sql',
      volatility: 'stable',
      body: 'SELECT * FROM todos WHERE NOT done;',
    }),
    // Signature only: the function already exists in the database
    search_todos: rpc({ args: { q: 'text' }, returns: 'jsonb' }),
  },
});
```

SDK calls: `client.rpc.count_open_todos({})`, `client.rpc.complete_all({ p_user: id })`. See [SDK](/api/sdk#rpc-calls).

## RpcDef

```ts
interface RpcDef {
  readonly _rpc: true;
  readonly args?: Record<string, ColumnType>;
  readonly returns?: RpcReturnType;
  readonly body?: string;
  readonly language?: RpcLanguage;
  readonly security?: RpcSecurity;
  readonly volatility?: RpcVolatility;
  readonly immutable?: boolean;
  readonly set?: Readonly<Record<string, string>>;
  readonly allowAnon?: boolean;
}

type RpcLanguage = 'plpgsql' | 'sql';
type RpcSecurity = 'invoker' | 'definer';
type RpcVolatility = 'volatile' | 'stable' | 'immutable';
type RpcReturnType = ColumnType | 'void' | RpcTableReturn | RpcSetofReturn;
interface RpcTableReturn { readonly table: Readonly<Record<string, ColumnType>>; }
interface RpcSetofReturn { readonly setof: string; } // a schema table or a column type
```

`_rpc: true` marks the object as an RPC; anything in `rpcs` without it is reported as `INVALID_RPC`. All of these types are exported from `accessnexus`.
