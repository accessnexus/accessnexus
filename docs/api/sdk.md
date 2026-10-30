# Generated SDK

A typed wrapper over a supabase-js client, generated into `output.sdk` (default `./generated/sdk`) by `accessnexus generate`. RLS still applies: every call runs as the signed-in user of the wrapped client.

## Files

| Mode | File | Contents |
| --- | --- | --- |
| Manual | `types.ts` | `Json`; per table: `<Table>` (row), `<Table>Create`, `<Table>Update`; and a Supabase-shaped `Database` interface including `Functions` for every RPC. |
| Manual | `client.ts` | `createAccessNexusClient`, `AccessNexusClient`, `AccessNexusProvider`, `ColumnsOf`, `SelectedRow`; re-exports `Json`. Imports from `./types.js`. |
| Database | `client.ts` | `createAccessNexusClient`, `AccessNexusClient`, `AccessNexusProvider`, `ColumnsOf`, `SelectedRow`. Imports `Database` from `adapterOptions.databaseTypes` (default `'./database.types'`, relative to the SDK folder). |

`<Table>` is the table name in PascalCase (`org_members` to `OrgMembers`). Both files are derived: never edit them, regenerate.

`accessnexus init` also writes a wrapper next to them that creates the Supabase client and exports a ready instance: `index.ts` (exports `accessnexus`), or on Next.js `browser.ts` (exports `accessnexus`) and `server.ts` (exports `createServerAccessNexus()`). That wrapper is your file; `generate` never touches it.

## Generated types (manual mode)

| Type | Definition |
| --- | --- |
| `Json` | `string \| number \| boolean \| null \| { [key: string]: Json \| undefined } \| Json[]`, identical to the `Json` of `supabase gen types`. Used for `json`/`jsonb` columns and RPC args/returns. |
| `<Table>` | A type alias (not an interface) with one property per column, typed as in [column types](/api/schema#column-types): `\| null` when nullable, `string` for uuid/text/dates/timestamps, `number` for numerics, `Json` for json/jsonb, enum columns as a union of their values. This is the shape `supabase gen types` produces for the same table, so rows are assignable both ways, and the generated `Database` can be passed to `createClient<Database>()`. |
| `<Table>Create` | Required: non-nullable columns without a `default`. Optional: nullable columns, columns with a `default`, and a `uuid` or `bigint` primary key. |
| `<Table>Update` | `Partial<Omit<<Table>, '<primaryKey>'>>` |
| `Database` | `{ public: { Tables: { <table>: { Row; Insert; Update; Relationships: [] } }; Views; Functions: { <rpc>: { Args; Returns } }; Enums; CompositeTypes } }` |

An RPC's `Args` is built from `args` (`{}` when there are none); `Returns` from `returns` (`unknown` when omitted or `'void'`).

## createAccessNexusClient

```ts
function createAccessNexusClient<TClient extends AccessNexusProvider>(provider: TClient): {
  auth: TClient['auth'];
  [table: string]: TableAccessors;   // one property per table
  rpc: { [name: string]: (args) => Promise<{ data; error }> }; // only when the schema has RPCs
};

type AccessNexusClient<TClient extends AccessNexusProvider = AccessNexusProvider> =
  ReturnType<typeof createAccessNexusClient<TClient>>;

// Loose shape a real supabase-js client satisfies
type AccessNexusProvider = {
  auth: unknown;
  from(table: string): unknown;
  rpc(name: string, args?: object): unknown;
};
```

| Parameter | Type | Description |
| --- | --- | --- |
| `provider` | `AccessNexusProvider` | A supabase-js client (`createClient(...)`, `createBrowserClient(...)`, `createServerClient(...)`), or any object with `auth`, `from` and `rpc`. |

The factory is generic over the provider, so `auth` keeps the provider's type: with `createBrowserClient<Database>()` / `createServerClient()` from `@supabase/ssr` or `createClient()` from `@supabase/supabase-js`, `db.auth.signInWithOAuth(...)` is fully typed. To name the client type, pass the provider type: `AccessNexusClient<SupabaseClient<Database>>` (without it, `auth` is `unknown`). Internally the provider is used through a loose query-builder view; each method casts its result to the documented type.

```ts
import { createClient } from '@supabase/supabase-js';
import { createAccessNexusClient } from './generated/sdk/client.js';

const db = createAccessNexusClient(createClient('https://xyz.supabase.co', 'public-anon-key'));

export async function example(userId: string, postId: string) {
  const { data: me } = await db.profiles.findById(userId);
  const { data: drafts } = await db.posts.findMany({ author_id: userId, status: 'draft' });
  await db.posts.create({ author_id: userId, title: 'Hello', status: 'draft' });
  await db.posts.update(postId, { status: 'published' });
  await db.posts.delete(postId);
  const { data: session } = await db.auth.getSession();
  return { me, drafts, session };
}
```

## Table methods

Every table in the schema gets these accessors. `<pk>` is the table's `primaryKey` (or `id`).

| Method | Signature | Query sent |
| --- | --- | --- |
| `findMany` | `(filter?: Partial<Row>, options?: { columns?; include? }) => QueryResult<Selected[]>` | `from(t).select(<columns or *>[, joins])[.is(softDelete, null)].match(filter ?? {})` |
| `findOne` | `(filter: Partial<Row>, options?: { columns?; include? }) => QueryResult<Selected>` | `from(t).select(<columns or *>[, joins])[.is(softDelete, null)].match(filter).maybeSingle()` |
| `findById` | `(id: string, options?: { columns?; include? }) => QueryResult<Selected>` | `from(t).select(<columns or *>[, joins]).eq(<pk>, id)[.is(softDelete, null)].maybeSingle()` |
| `create` | `(data: Create) => QueryResult<Row>` | `from(t).insert(data).select().single()` |
| `update` | `(id: string, data: Update) => QueryResult<Row>` | `from(t).update(data).eq(<pk>, id).select().single()` |
| `delete` | `(id: string) => QueryResult<null>` | `from(t).delete().eq(<pk>, id)` |

`Selected` is `Row` (plus the `include`d relations), or `Pick<Row, ...columns>` when `columns` is given.

```ts
type QueryResult<T> = Promise<{ data: T | null; error: unknown }>;
```

Types per mode:

| | Manual mode | Database mode |
| --- | --- | --- |
| `Row` | `<Table>` | `Database['public']['Tables'][t]['Row']` |
| `Create` | `<Table>Create` | `...[t]['Insert']` |
| `Update` | `<Table>Update` | `...[t]['Update']` |

Notes:

- `filter` is passed to supabase-js `match`: equality on every given column, AND-ed. For other operators use the wrapped supabase-js client directly.
- `id` is typed `string` for every primary key type.
- `create` and `update` return the written row (`INSERT/UPDATE ... RETURNING`), so the table's `select` policy must admit that row, or the call fails with an RLS error.
- `delete` sends a real DELETE. On a `softDelete` table the trigger turns it into `SET <column> = NOW()`, so the DELETE policy decides. supabase-js returns `data: null` for a delete without `.select()`.
- `findOne` and `findById` use `maybeSingle()`: no matching (or no visible) row is `{ data: null, error: null }`, not an error. More than one row matching a `findOne` filter is an error (PGRST116), so filter on a unique column (`{ slug }`, `{ email }`).
- On a `softDelete` table, `findMany`, `findOne` and `findById` add `.is(<column>, null)`. RLS itself does not hide soft-deleted rows.

### columns

`options.columns` is an array of column names. It sends `select('a, b')` instead of `select('*')` and narrows the result to `Pick<Row, 'a' | 'b'>`. Names are checked at compile time against the table's columns (`ColumnsOf<'table'>`): an unknown name is a type error. At runtime the names are passed through as given; an empty array selects `*`. It combines with `include` (the embeds are appended).

```ts
import { createClient } from '@supabase/supabase-js';
import { createAccessNexusClient } from './generated/sdk/client.js';

const db = createAccessNexusClient(createClient('https://xyz.supabase.co', 'public-anon-key'));

export async function lookup(slug: string) {
  // data: Pick<Posts, 'id' | 'title'> | null — null (no error) when no post has this slug
  const { data: post } = await db.posts.findOne({ slug }, { columns: ['id', 'title'] });
  // db.posts.findMany({}, { columns: ['nope'] }) does not compile
  return post?.title;
}
```

### include

Tables with foreign keys to other tables of the schema accept `options.include`, which embeds the referenced row through PostgREST:

| Item | Value |
| --- | --- |
| Source | the table-level `references` map, entries of the form `'table.column'` whose table is in the schema. Column-level `ColumnDef.references` and external references (`auth.users.id`) are not included. |
| Alias | the column name without a trailing `_id` (`author_id` to `author`); deduplicated with a suffix on collision |
| Embed | `<alias>:<target>!<table>_<column>_fkey(*)` |
| Result type | `Row & { <alias>: TargetRow \| null }` for each alias set to `true` |

```ts
import { createClient } from '@supabase/supabase-js';
import { createAccessNexusClient } from './generated/sdk/client.js';

const db = createAccessNexusClient(createClient('https://xyz.supabase.co', 'public-anon-key'));

export async function postsWithAuthors(orgId: string) {
  // posts.references = { author_id: 'profiles.id' }
  const { data } = await db.posts.findMany({ org_id: orgId }, { include: { author: true } });
  return data?.map((post) => `${post.title} by ${post.author?.name ?? 'unknown'}`);
}
```

## RPC calls

When the schema declares RPCs, the client has an `rpc` namespace with one method per RPC:

```ts
rpc.<name>(args: Functions['<name>']['Args']): QueryResult<Functions['<name>']['Returns']>
// calls provider.rpc('<name>', args)
```

In manual mode `Functions` comes from the generated `types.ts` (an RPC without `args` takes `{}`); in Database mode from your `Database` type.

```ts
import { createClient } from '@supabase/supabase-js';
import { createAccessNexusClient } from './generated/sdk/client.js';

const db = createAccessNexusClient(createClient('https://xyz.supabase.co', 'public-anon-key'));

export async function dashboard(orgId: string) {
  const { data, error } = await db.rpc.get_org_dashboard({ p_org_id: orgId });
  if (error) throw error;
  return data;
}
```

## auth

`client.auth` is the provider's `auth` object, passed through unchanged (`db.auth.signInWithPassword(...)`, `db.auth.signInWithOAuth(...)`, `db.auth.getUser()`, ...). Its type is `TClient['auth']`, the provider's own `auth` type (`SupabaseAuthClient` for a supabase-js or @supabase/ssr client).

## Typing tips

- Manual mode: import the row types from `types.ts` (`import type { Posts, PostsCreate } from './generated/sdk/types.js'`).
- Database mode: row types are `Database['public']['Tables'][t]['Row' | 'Insert' | 'Update']` from your own file, identical to Supabase's. Regenerate `database.types.ts` with the Supabase CLI after every `push`, then run `accessnexus generate`.
- `AccessNexusClient<SupabaseClient<Database>>` is the client's type, for passing it around: `function load(db: AccessNexusClient<SupabaseClient<Database>>) { ... }`. `AccessNexusClient` without the argument works too, with `auth: unknown`.
