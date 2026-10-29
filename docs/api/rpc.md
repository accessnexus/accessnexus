# rpc

Define a Postgres function, exposed through Supabase as an RPC and typed in the SDK as `client.rpc.<name>()`. Guide: [RPCs](/guide/rpcs).

```ts
function rpc(config?: {
  args?: Record<string, ColumnType>;
  returns?: RpcReturnType;
  body?: string;
  language?: RpcLanguage;
  security?: RpcSecurity;
  immutable?: boolean;
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
| `returns` | `ColumnType \| 'void'` | `'void'` | Return type. Omitted: `RETURNS VOID` in SQL, `unknown` in the SDK. |
| `body` | `string` | `undefined` | Function body without the `CREATE FUNCTION` wrapper. Without it no SQL is generated. |
| `language` | `'plpgsql' \| 'sql'` | `'plpgsql'` | `LANGUAGE`. |
| `security` | `'invoker' \| 'definer'` | `'invoker'` | `SECURITY INVOKER` or `SECURITY DEFINER`. |
| `immutable` | `boolean` | `false` | `IMMUTABLE` instead of `VOLATILE`. |
| `allowAnon` | `boolean` | `false` | `security: 'definer'` only: keep `EXECUTE` for `anon`. |

Unknown argument types are reported as `UNKNOWN_COLUMN_TYPE`; a bare `auth.uid()` in the body as `UNWRAPPED_AUTH_CALL`.

::: warning
Enum types (`"enum('a','b')"`) are accepted by `validate` for `args` and `returns` but are emitted literally into the SQL signature, which Postgres rejects. Use `'text'` and cast inside the body.
:::

## Generated SQL

```sql
CREATE OR REPLACE FUNCTION <name>(<arg> <TYPE>, ...)
RETURNS <TYPE>
LANGUAGE <language>
SECURITY <INVOKER|DEFINER>
<VOLATILE|IMMUTABLE>
SET search_path = pg_catalog, public
AS $$
<body>
$$;
```

With `language: 'plpgsql'`, a body that does not start with `DECLARE` or `BEGIN` is wrapped in `BEGIN ... END;`. With `language: 'sql'`, or a body that starts with `DECLARE` / `BEGIN`, it is emitted as written.

## Security and grants

| `security` | `allowAnon` | Grants emitted | Callable by |
| --- | --- | --- | --- |
| `'invoker'` | ignored | none | Supabase default for new public functions (`anon`, `authenticated`, `service_role`). RLS applies inside. |
| `'definer'` | `false` | `REVOKE EXECUTE ON FUNCTION <name>(<types>) FROM PUBLIC, anon;` `GRANT EXECUTE ... TO authenticated, service_role;` | signed-in users and the service role |
| `'definer'` | `true` | `REVOKE ... FROM PUBLIC;` `GRANT ... TO authenticated, service_role, anon;` | everyone |

::: warning
A `SECURITY DEFINER` function runs as its owner and bypasses RLS. Check the caller inside the body (`(SELECT auth.uid())`, reject `NULL` for anonymous callers) and schema-qualify tables (`public.todos`). Use `allowAnon: true` only for functions that are safe for anyone holding the anon key.
:::

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
  readonly immutable?: boolean;
  readonly allowAnon?: boolean;
}

type RpcLanguage = 'plpgsql' | 'sql';
type RpcSecurity = 'invoker' | 'definer';
type RpcReturnType = ColumnType | 'void';
```

`_rpc: true` marks the object as an RPC; anything in `rpcs` without it is reported as `INVALID_RPC`. All of these types are exported from `accessnexus`.
