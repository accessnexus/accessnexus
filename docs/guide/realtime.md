# Realtime

Supabase Realtime has two parts, and AccessNexus covers both from the schema:

- **Postgres Changes**: subscribers receive inserts, updates and deletes of a table. You opt a table in with `realtime: true`; Realtime only delivers a row to users whose SELECT policy shows it.
- **Broadcast and Presence**: messages and "who is online" on a named channel. You declare private channels with `channel()`; their rules become RLS policies on `realtime.messages`.

Both end up in `generated/policies/realtime.sql`, which `push` applies like any policy file. The SDK gets typed `subscribe` and `channels` accessors.

## Postgres Changes

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table } from 'accessnexus';

export default defineSchema({
  tasks: table({
    columns: { id: 'uuid', project_id: 'uuid', title: 'text', done: 'boolean' },
    primaryKey: 'id',
    policies: { select: policy.isAuthenticated(), insert: policy.isAuthenticated() },
    realtime: true,
  }),
});
```

`realtime.sql` adds the table to the `supabase_realtime` publication (only if it is not there yet) and sets `REPLICA IDENTITY DEFAULT`:

```sql
ALTER PUBLICATION supabase_realtime ADD TABLE public.tasks;
ALTER TABLE public.tasks REPLICA IDENTITY DEFAULT;
```

| Value | Effect on push |
| --- | --- |
| `realtime: true` | Add the table to the publication. |
| `realtime: { replicaIdentity: 'full' }` | Same, with `REPLICA IDENTITY FULL` (see [old rows](#old-rows-and-deletes)). |
| `realtime: false` | Remove the table from the publication. |
| key left out | Do nothing: a table you enabled in the dashboard stays enabled. |

A database without the `supabase_realtime` publication (plain Postgres) gets a warning from `push`, not an error.

### Subscribing from the SDK

Tables with `realtime: true` get `subscribe(listener, options?)`, which returns a function that unsubscribes:

```ts
const stop = db.tasks.subscribe((change) => {
  if (change.eventType === 'INSERT') console.log('new task', change.new.title);
}, { filter: { project_id: projectId } });

// later
stop();
```

- `change` is typed from the table's row: `new` is the row on INSERT/UPDATE, `old` holds the primary key.
- `event: 'INSERT' | 'UPDATE' | 'DELETE'` listens to one event and narrows `change` (default `'*'`).
- `filter` runs on the Realtime server and names exactly one column, as Realtime allows: `{ project_id: id }` (eq), `{ status: ['todo', 'done'] }` (in), or `{ views: { gt: 10 } }` (`eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `in`). Unknown columns and wrong value types do not compile; two columns throw.
- `onStatus(status, error?)` reports the channel status (`SUBSCRIBED`, `CHANNEL_ERROR`, `TIMED_OUT`, `CLOSED`).

With [TanStack Query helpers](/api/sdk#tanstack-query-react-query) enabled, `q.tasks.invalidateOnChange(options?)` invalidates the table's queries (and the tables that embed it through `include`) on every change:

```tsx
useEffect(() => q.tasks.invalidateOnChange({ filter: { project_id: projectId } }), [projectId]);
```

### Old rows and deletes

Supabase applies RLS to Postgres Changes with these limits, which hold for every table AccessNexus generates (RLS is always on):

- **Deletes are not filtered by RLS.** Every subscriber of the table receives DELETE events, carrying only the primary key of the deleted row. Do not put secrets in primary keys. Server-side filters do not apply to DELETE either.
- **`old` contains only the primary key**, even with `REPLICA IDENTITY FULL`. That is why `replicaIdentity: 'full'` only makes sense on a table with `enableRLS: false`; `validate` warns `REALTIME_REPLICA_FULL_WITH_RLS` otherwise.
- Soft-delete tables send an UPDATE (the trigger sets `deleted_at`), not a DELETE.

## Broadcast and Presence

Private channels are authorized by RLS on `realtime.messages`: a SELECT policy lets a user receive (broadcast messages, presence state), an INSERT policy lets them send (broadcast) or track their presence. Declare them with `channel()` under `defineSchema`'s `channels` option:

```ts [accessnexus.schema.ts]
import { channel, defineSchema, policy, table } from 'accessnexus';

export default defineSchema({
  projects: table({
    columns: { id: 'uuid', owner_id: 'uuid', name: 'text' },
    primaryKey: 'id',
    policies: { select: policy.isOwner('owner_id') },
  }),
}, {
  channels: {
    // 'project:<uuid>': open to whoever can read that project row.
    project_room: channel({
      topic: 'project:{id}',
      table: 'projects',
      broadcast: { receive: true, send: true },
      presence: { receive: true, send: true },
    }),
    // A fixed topic: everyone listens, only app admins send.
    announcements: channel({
      topic: 'announcements',
      broadcast: { receive: policy.public(), send: policy.hasRole('admin') },
    }),
    // One inbox per user: 'inbox:<user id>'.
    inbox: channel({
      topic: 'inbox:{user_id}',
      broadcast: { receive: policy.custom('{user_id} = (SELECT auth.uid())::text') },
    }),
  },
});
```

### Topic and table

- `topic` is a fixed name (`'announcements'`) or a prefix plus one trailing parameter (`'project:{id}'`). Letters, digits and `:_.-` only.
- With `table`, the parameter is that table's primary key and **every rule of the channel also requires that the user can SELECT the row**. The check runs as the user, so the table's own policies decide: a channel is never wider than the row it belongs to. A malformed key (`project:not-a-uuid`) is denied, never an error.

### Rules

Each of `broadcast` and `presence` takes `receive` and `send`:

| Rule | Who |
| --- | --- |
| `true` | Any signed-in user (plus the row check when `table` is set). |
| `false` or left out | Nobody: no policy is created, and an existing one is dropped. |
| `policy.isAuthenticated()`, `policy.public()`, `policy.none()`, `policy.hasRole(role)` | As in table policies. `public()` admits anonymous users. |
| `policy.custom(sql)` | Raw SQL on `realtime.messages`. `{param}` is the topic parameter as text; `realtime.topic()` is the whole topic. |
| `policy.any([...])`, `policy.all([...])` | Combinations of the rules above. |

Rules that read columns of a table row (`isOwner`, `belongsTo`, `matchesField`, `withCheck`) do not apply to `realtime.messages`; `validate` reports `CHANNEL_RULE_NOT_SUPPORTED`. Use `table` for "users who can see this row", or `policy.custom`.

### What push does

`realtime.sql` drops and recreates the policies `<prefix>_rt_<channel>_<broadcast|presence>_<receive|send>`, and drops any other policy on `realtime.messages` whose name starts with `<prefix>_rt_`, so removing a channel or a rule revokes it. Policies you wrote by hand under another name are left alone. `channels: {}` removes every channel policy of the prefix.

### Joining from the SDK

`client.channels.<name>(param)` returns the supabase-js `RealtimeChannel` for the topic, created private (`{ config: { private: true } }`), so Realtime checks the policies on join, send and receive:

```ts
const room = db.channels.project_room(projectId);
room
  .on('broadcast', { event: 'cursor' }, ({ payload }) => moveCursor(payload))
  .on('presence', { event: 'sync' }, () => setViewers(room.presenceState()))
  .subscribe(async (status) => {
    if (status === 'SUBSCRIBED') await room.track({ user_id: userId });
  });

room.send({ type: 'broadcast', event: 'cursor', payload: { x, y } });
// leave: supabase.removeChannel(room)
```

Fixed topics take no argument: `db.channels.announcements()`. The supabase-js client sends the signed-in user's token to Realtime. On a server client without a session, call `supabase.realtime.setAuth(token)` before joining.

::: tip Private channels only
In the Supabase dashboard (Realtime settings) you can turn off "Allow public access", so clients cannot bypass these policies by joining a channel as public.
:::

## Checks

`validate` reports:

| Code | Severity | When |
| --- | --- | --- |
| `INVALID_REALTIME` | error | `realtime` is not `true`, `false` or `{ replicaIdentity }`. |
| `REALTIME_NOT_READABLE` | warning | A published table has no select policy: nobody receives its changes. |
| `REALTIME_RLS_DISABLED` | warning | A published table has `enableRLS: false`: every subscriber, anon included, receives every row. |
| `REALTIME_REPLICA_FULL_WITH_RLS` | warning | `replicaIdentity: 'full'` with RLS on has no effect for subscribers. |
| `INVALID_CHANNEL` | error | Bad topic, unknown option, `table` without a `{param}` or with a composite key, a `{placeholder}` that is not the topic parameter. |
| `CHANNEL_RULE_NOT_SUPPORTED` | error | A row-level rule (`isOwner`, `belongsTo`, ...) in a channel. |
| `CHANNEL_TABLE_NOT_READABLE` | warning | The channel's table has no select policy, so nobody can join. |
| `CHANNEL_PUBLIC_SEND` | warning | Anonymous users can send. |
| `CHANNEL_CLOSED` | warning | The channel grants nothing. |

## Existing projects

`init --db-url` imports tables already in the `supabase_realtime` publication as `realtime: true` (`{ replicaIdentity: 'full' }` when set). Policies already on `realtime.messages` are listed in a comment but not imported: `push` leaves them as they are, because it only manages policies with its own `<prefix>_rt_` names. Port them to `channels` to manage them from the schema.

## Related

- [Generated SDK](/api/sdk#realtime)
- [defineSchema / table](/api/schema)
- [Security model](/guide/security#realtime-follows-the-same-policies)
