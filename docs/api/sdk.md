# Generated SDK

A typed wrapper over a supabase-js client, generated into `output.sdk` (default `./generated/sdk`) by `accessnexus generate`. RLS still applies: every call runs as the signed-in user of the wrapped client.

## Files

| Mode | File | Contents |
| --- | --- | --- |
| Manual | `types.ts` | `Json`; per table: `<Table>` (row), `<Table>Create`, `<Table>Update`; and a Supabase-shaped `Database` interface including `Functions` for every RPC. |
| Manual | `client.ts` | `createAccessNexusClient`, `AccessNexusClient`, `AccessNexusProvider`, `ColumnsOf`, `SelectedRow`; re-exports `Json`. Imports from `./types.js`. |
| Database | `client.ts` | `createAccessNexusClient`, `AccessNexusClient`, `AccessNexusProvider`, `ColumnsOf`, `SelectedRow`. Imports `Database` from `adapterOptions.databaseTypes` (default `'./database.types'`, relative to the SDK folder). |
| Both, with `adapterOptions.reactQuery: true` | `react-query.ts` | `createAccessNexusQueries`, `AccessNexusQueries`, `accessNexusKeys`. TanStack Query v5 helpers over the client; see [TanStack Query](#tanstack-query-react-query). |

`<Table>` is the table name in PascalCase (`org_members` to `OrgMembers`). These files are derived: never edit them, regenerate.

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

::: tip Import paths
Examples import `./client.js` (NodeNext ESM). In Next.js, Vite and other bundler projects import `./client` without the extension — Turbopack cannot map `./client.js` to `client.ts`. The wrappers `init` writes already follow your project: extensionless for bundler frameworks (or a tsconfig with `moduleResolution: "bundler"`), `.js` for plain Node.
:::

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
| `update` | `(id: string, data: Update) => QueryResult<Row>` | `from(t).update(data).eq(<pk>, id).select().maybeSingle()`; no row changed is [`ACCESSNEXUS_NOT_FOUND_OR_DENIED`](#errors) |
| `delete` | `(id: string) => QueryResult<null>` | `from(t).delete({ count: 'exact' }).eq(<pk>, id)`; nothing deleted is [`ACCESSNEXUS_NOT_FOUND_OR_DENIED`](#errors) |
| `updateOne` | `(filter: RowFilter, data: Update, options?: { columns? }) => QueryResult<Selected>` | `from(t).update(data).match(filter)[.is(softDelete, null)].select(<columns or *>).maybeSingle()` |
| `updateMany` | `(filter: RowFilter, data: Update, options?: { columns? }) => QueryResult<Selected[]>` | `from(t).update(data).match(filter)[.is(softDelete, null)].select(<columns or *>)` |
| `deleteOne` | `(filter: RowFilter, options?: { columns? }) => QueryResult<Selected>` | `from(t).delete().match(filter)[.is(softDelete, null)].select(<columns or *>).maybeSingle()` |
| `deleteMany` | `(filter: RowFilter, options?: { columns? }) => QueryResult<Selected[]>` | `from(t).delete().match(filter)[.is(softDelete, null)].select(<columns or *>)` |

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
| `RowFilter` | `{ [column]?: column type }`, at least one key | same, from `Row` |

Notes:

- `filter` is passed to supabase-js `match`: equality on every given column, AND-ed. For other operators use the wrapped supabase-js client directly.
- `id` is typed `string` for every primary key type.
- `create` and `update` return the written row (`INSERT/UPDATE ... RETURNING`), so the table's `select` policy must admit that row, or the call fails with an RLS error.
- `delete` sends a real DELETE and asks for the affected-row count, so a delete that removed nothing is an error (see [Errors](#errors)). On a `softDelete` table the trigger turns it into `SET <column> = NOW()`, so the DELETE policy decides; the SDK checks the live row before and after (gone means deleted). `data` is `null` on success.
- `findOne` and `findById` use `maybeSingle()`: no matching (or no visible) row is `{ data: null, error: null }`, not an error. More than one row matching a `findOne` filter is an error (PGRST116), so filter on a unique column (`{ slug }`, `{ email }`).
- On a `softDelete` table, `findMany`, `findOne` and `findById` add `.is(<column>, null)`. RLS itself does not hide soft-deleted rows.

### Filtered writes

`updateOne` / `updateMany` / `deleteOne` / `deleteMany` write by a filter instead of the primary key, in one round trip, and return the written rows:

```ts
import { createClient } from '@supabase/supabase-js';
import { createAccessNexusClient } from './generated/sdk/client.js';

const db = createAccessNexusClient(createClient('https://xyz.supabase.co', 'public-anon-key'));

export async function publish(slug: string) {
  // a unique non-PK column: one request, the updated row (an error when none changed)
  const { data, error } = await db.posts.updateOne({ slug }, { published: true }, { columns: ['id', 'slug'] });
  if (error) throw error;
  return data; // Pick<Posts, 'id' | 'slug'> | null (null only together with an error)
}
```

- The filter is required and typed `RowFilter<T, TFilter>` (exported from the generated client): keys must be columns, values the column types, and `{}` is a type error. At runtime an empty filter, or one whose values are all `undefined`, throws `[AccessNexus] <table>.<method>: the filter must name at least one column (refusing to write every row)` before any request is sent. `data` is the table's `Update` type.
- `updateOne` / `deleteOne` use `maybeSingle()`. No row changed (missing, hidden by RLS or not writable) is an `ACCESSNEXUS_NOT_FOUND_OR_DENIED` error, never `data: null` (see [Errors](#errors)). More than one match is a PGRST116 error and PostgREST rolls the write back. `updateMany` / `deleteMany` still return `[]` when nothing matches.
- Returned rows come from `.select()` (`UPDATE/DELETE ... RETURNING`), so they are returned only when the `select` policy lets the user see them. `options.columns` narrows them as in `findOne`.
- On a `softDelete` table these methods touch only live rows (`.is(<column>, null)`). The trigger turns the DELETE into an UPDATE, so the DELETE itself returns no row: `deleteOne` returns the row as it was before (the SDK reads it first) and `deleteMany` returns `[]`, even though the rows were soft-deleted.

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

## Errors

Results are `{ data, error }` like supabase-js. RLS refuses some writes with an error and others silently, by touching zero rows. The SDK turns the silent cases into an error, so a write never "succeeds" without changing anything. The full table of how each statement is refused is in [How a denial shows](/guide/testing#how-a-denial-shows).

### ACCESSNEXUS_NOT_FOUND_OR_DENIED

`update(id)`, `delete(id)`, `updateOne` and `deleteOne` return this error when no row was changed: the row does not exist, RLS hides it, or RLS does not let this user change it. The SDK cannot tell these apart (and should not: it would reveal rows the user cannot see).

```ts
type AccessNexusError = {
  code: 'ACCESSNEXUS_NOT_FOUND_OR_DENIED';
  message: string;
  details: { table: string; method: string; id?: unknown; filter?: Record<string, unknown> };
  hint: string;
};
```

| Method | `details` |
| --- | --- |
| `update(id)`, `delete(id)` | `{ table, method, id }` |
| `updateOne`, `deleteOne` | `{ table, method, filter }` |

- `delete(id)` asks for the affected-row count. On a `softDelete` table it checks the live row before and after the DELETE; a row that is gone from the live set counts as deleted.
- `updateMany` and `deleteMany` are not affected: they return `[]` when nothing matches.
- React Query mutations throw this error like any other.
- Before this error existed, `delete` reported success, `update` returned a raw `PGRST116` and `updateOne` / `deleteOne` returned `data: null`.

### Helpers

`client.ts` exports these, so the app does not compare codes by hand:

| Export | Returns `true` when |
| --- | --- |
| `NOT_FOUND_OR_DENIED` | (constant) the string `'ACCESSNEXUS_NOT_FOUND_OR_DENIED'`. |
| `isNotFoundOrDenied(error)` | the error is the SDK's `ACCESSNEXUS_NOT_FOUND_OR_DENIED`. |
| `isAccessDenied(error)` | the database refused the request: `isNotFoundOrDenied`, or SQLSTATE `42501` (an INSERT or `WITH CHECK` rejected by RLS, a locked column, a definer RPC check). |
| `isLockedColumn(error)` | a [`trigger.lockColumns`](/api/trigger#lockcolumns) guard refused the update: SQLSTATE `42501` with a HINT starting with `accessnexus:locked_column:` (`<table>.<column>`). |

```ts
import { createClient } from '@supabase/supabase-js';
import { createAccessNexusClient, isAccessDenied, isLockedColumn, isNotFoundOrDenied } from './generated/sdk/client.js';

const db = createAccessNexusClient(createClient('https://xyz.supabase.co', 'public-anon-key'));

export async function rename(id: string, name: string) {
  const { data, error } = await db.projects.update(id, { name });
  if (isLockedColumn(error)) return 'that column cannot be changed'; // trigger.lockColumns
  if (isNotFoundOrDenied(error)) return 'not found, or not yours';
  if (isAccessDenied(error)) return 'not allowed'; // 42501
  if (error) throw error;
  return data;
}
```

## RPC calls

When the schema declares RPCs, the client has an `rpc` namespace with one method per RPC:

```ts
rpc.<name>(args: Functions['<name>']['Args']): QueryResult<Functions['<name>']['Returns']>
// calls provider.rpc('<name>', args)
```

In manual mode `Functions` comes from the generated `types.ts` (an RPC without `args` takes `{}`; a `{ table }` / `{ setof }` return is an array of rows, see [Return types](/api/rpc#return-types)); in Database mode from your `Database` type.

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

## Realtime

Tables with `realtime: true` get `subscribe`, and channels declared with [`channel()`](/api/realtime#channel) appear under `client.channels`. See the [Realtime guide](/guide/realtime).

```ts
const stop = db.tasks.subscribe((change) => {
  // change.eventType: 'INSERT' | 'UPDATE' | 'DELETE'; change.new is a Tasks row
}, { event: '*', filter: { project_id: projectId }, onStatus: (status) => console.log(status) });
stop(); // unsubscribe (removes the channel)

const room = db.channels.project_room(projectId); // supabase-js RealtimeChannel, private
room.on('broadcast', { event: 'cursor' }, ({ payload }) => draw(payload)).subscribe();
```

| Option of `subscribe` | Type | Description |
| --- | --- | --- |
| `event` | `'INSERT' \| 'UPDATE' \| 'DELETE' \| '*'` | Event to listen to (default `'*'`); narrows the listener's `change`. |
| `filter` | `RealtimeFilter<Row>` | One column: a value (eq), an array (in), or `{ eq \| neq \| lt \| lte \| gt \| gte \| in }`. Two columns or `null` throw. Ignored by Realtime for DELETE. |
| `onStatus` | `(status, error?) => void` | `SUBSCRIBED`, `CHANNEL_ERROR`, `TIMED_OUT`, `CLOSED`. |

`change` is `RealtimeChange<Row>`: `{ eventType, new, old, schema, table, commit_timestamp, errors }`, where `new` is the row on INSERT/UPDATE (empty on DELETE) and `old` holds the primary key (RLS tables send no more). `client.channels.<name>(param)` returns `ChannelOf<TClient>`: the `RealtimeChannel` type of the Supabase client you passed in.


## Edge Functions

Functions declared with [`edgeFunction()`](/api/edge-functions) appear under `client.functions`, camelCased (`invite-member` → `inviteMember`). See the [Edge Functions guide](/guide/edge-functions).

```ts
const { data, error } = await db.functions.inviteMember({ org_id: orgId, email, role: 'member' });
// data: InviteMemberOutput | null; on failure: await error.context.json() → { error: { code, message, issues? } }
```

Each call is `supabase.functions.invoke('<name>', { body: input, method: 'POST', headers?, region? })`, so the signed-in user's JWT goes along. `client.ts` exports `<Name>Input`, `<Name>Output` and `FunctionInvokeOptions`.


## TanStack Query (React Query)

With `adapterOptions: { reactQuery: true }`, `generate` also writes `react-query.ts` next to `client.ts`: query keys, `queryOptions` for every read and mutation options for every write and RPC, wrapping the generated client. It needs `@tanstack/react-query` v5 in your app (`npm i @tanstack/react-query`); AccessNexus itself does not depend on it. The file is the same in manual and Database mode.

```tsx
import { QueryClient, useMutation, useQuery } from '@tanstack/react-query';
import { createAccessNexusQueries } from './generated/sdk/react-query.js';
import { accessnexus } from './generated/sdk/index.js'; // your init wrapper

export const queryClient = new QueryClient();
export const q = createAccessNexusQueries(accessnexus, { queryClient });

export function Tasks({ projectId }: { projectId: string }) {
  const tasks = useQuery(q.tasks.findMany({ project_id: projectId }, { columns: ['id', 'title'] }));
  const create = useMutation(q.tasks.create()); // invalidates tasks (and tables that embed tasks)
  // tasks.data: Pick<Tasks, 'id' | 'title'>[] | undefined
  return null;
}
```

| Helper | Returns | Notes |
| --- | --- | --- |
| `q.<table>.findMany / findOne / findById(...)` | `queryOptions({ queryKey, queryFn })` | Same arguments and generics as the client (`columns`, `include` narrow `data`). Works with `useQuery`, `useSuspenseQuery`, `prefetchQuery`, `getQueryData(...queryKey)`. |
| `q.<table>.create / update / delete / updateOne / updateMany / deleteOne / deleteMany()` | `{ mutationKey, mutationFn, onSuccess }` | Variables: `create(row)`, `update({ id, data })`, `delete(id)`, `updateOne/updateMany({ filter, data })`, `deleteOne/deleteMany(filter)`. The empty-filter guard of the client still throws. |
| `q.rpc.<name>.query(args)` / `q.rpc.<name>.mutation()` | query / mutation options | Use `query` for reads, `mutation` for writes (it invalidates every AccessNexus query). |
| `q.functions.<name>.query(input)` / `q.functions.<name>.mutation()` | query / mutation options | Edge Functions; the mutation invalidates every AccessNexus query. |
| `q.<table>.invalidateOnChange({ event?, filter? })` | `() => void` | Only on `realtime: true` tables: subscribes and invalidates the table (and the tables that embed it) on every change. Needs `queryClient`. Use in an effect: `useEffect(() => q.tasks.invalidateOnChange(), [])`. |
| `accessNexusKeys` | key factory | `accessNexusKeys.<table>.all` = `['accessnexus', '<table>']`; `list`, `one`, `byId` and `rpc.<name>` below it. |

- `queryFn` turns `{ data, error }` into a value or a rejection: `error` is thrown as-is (the Supabase `PostgrestError`, with `code` / `message` / `details`). Lists resolve to `[]` instead of `null`; `findOne` / `findById` resolve to `null` when no visible row matches. A `RETURNS TABLE` / `SETOF` RPC (query and mutation) resolves to `Row[]`, never `null`. The `update`, `delete`, `updateOne` and `deleteOne` mutations throw `ACCESSNEXUS_NOT_FOUND_OR_DENIED` when no row changed (see [Errors](#errors)).
- Pass `queryClient` to get invalidation: on success a table write invalidates that table plus every table whose queries can embed it through `include`; an RPC mutation invalidates all AccessNexus queries. Without `queryClient`, nothing is invalidated.
- Add your own options by spreading: `useQuery({ ...q.tasks.findById(id), enabled: !!id })`, `useMutation({ ...q.tasks.update(), onError })`. A spread `onSuccess` replaces the generated one; call `queryClient.invalidateQueries({ queryKey: accessNexusKeys.tasks.all })` yourself in that case.
- RLS still applies: queries run as the user of the wrapped Supabase client. On a server, create one `QueryClient` per request.

## Typing tips

- Manual mode: import the row types from `types.ts` (`import type { Posts, PostsCreate } from './generated/sdk/types.js'`).
- Database mode: row types are `Database['public']['Tables'][t]['Row' | 'Insert' | 'Update']` from your own file, identical to Supabase's. Regenerate `database.types.ts` with the Supabase CLI after every `push`, then run `accessnexus generate`.
- `AccessNexusClient<SupabaseClient<Database>>` is the client's type, for passing it around: `function load(db: AccessNexusClient<SupabaseClient<Database>>) { ... }`. `AccessNexusClient` without the argument works too, with `auth: unknown`.
