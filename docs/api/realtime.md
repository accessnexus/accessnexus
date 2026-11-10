# channel / realtime

Reference for Supabase Realtime in the schema. For the walkthrough, see the [Realtime guide](/guide/realtime).

## realtime (table option)

```ts
type TableRealtime = boolean | { replicaIdentity?: 'default' | 'full' };
```

| Value | Generated SQL (`realtime.sql`) | SDK |
| --- | --- | --- |
| `true` | `ALTER PUBLICATION supabase_realtime ADD TABLE public.<table>` (if missing), `REPLICA IDENTITY DEFAULT` | `client.<table>.subscribe(...)` |
| `{ replicaIdentity: 'full' }` | Same, with `REPLICA IDENTITY FULL` | `client.<table>.subscribe(...)` |
| `false` | `ALTER PUBLICATION supabase_realtime DROP TABLE public.<table>` (if present) | none |
| left out | nothing | none |

Works in manual and Database mode. Without the `supabase_realtime` publication, `push` prints a warning and changes nothing.

## channel

```ts
// exported by the accessnexus package
function channel(def: ChannelDef): ChannelDef;

interface ChannelDef {
  topic: string;                // 'lobby' or 'room:{id}'
  table?: string;               // the {param} is this table's primary key
  broadcast?: ChannelAccess;
  presence?: ChannelAccess;
}

interface ChannelAccess {
  receive?: ChannelRule;        // SELECT on realtime.messages
  send?: ChannelRule;           // INSERT on realtime.messages
}

type ChannelRule = boolean | PolicyRule;
```

Pass channels to `defineSchema(tables, { channels: { <name>: channel({ ... }) } })`. Names are lowercase snake_case, up to 40 characters.

| Option | Description |
| --- | --- |
| `topic` | A fixed topic, or a prefix plus one trailing `{param}`. Letters, digits and `:_.-`. A topic that is only `{param}` is rejected (it would match every channel). |
| `table` | Requires a `{param}`. Every rule then also checks `EXISTS (SELECT 1 FROM public.<table> WHERE <pk> = <param>)` as the user, so the table's SELECT policy decides. `uuid` and integer keys are matched without a cast that could fail; a malformed parameter matches nothing. |
| `broadcast.receive` | Receive broadcast messages. |
| `broadcast.send` | Send broadcast messages. |
| `presence.receive` | See the presence state. |
| `presence.send` | Track your own presence. |

### Rules

| Rule | Policy role | Condition |
| --- | --- | --- |
| `true` | `authenticated` | `(SELECT auth.uid()) IS NOT NULL` |
| `false`, omitted, `policy.none()` | none | no policy (an existing one is dropped) |
| `policy.isAuthenticated()` | `authenticated` | `(SELECT auth.uid()) IS NOT NULL` |
| `policy.public()` | `public` | `TRUE` |
| `policy.hasRole(role)` | `authenticated` | `app_metadata.role` claim equals `role` |
| `policy.custom(sql)` | `public` | `sql`, with `{param}` replaced by the topic parameter (text) |
| `policy.any` / `policy.all` | widest / narrowest of the parts | OR / AND |

Every condition is also ANDed with the extension (`realtime.messages.extension = 'broadcast' | 'presence'`), the topic match and, with `table`, the row check.

### Generated policies

One policy per granted extension and action, on `realtime.messages`:

```sql
CREATE POLICY "accessnexus_rt_project_room_broadcast_receive"
  ON realtime.messages FOR SELECT
  TO authenticated
  USING (
    realtime.messages.extension = 'broadcast'
    AND left(realtime.topic(), 8) = 'project:'
    AND length(realtime.topic()) > 8
    AND (SELECT auth.uid()) IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.projects WHERE projects.id = CASE WHEN substr(realtime.topic(), 9) ~* '^[0-9a-f]{8}-...$' THEN substr(realtime.topic(), 9)::uuid END)
  );
```

Names are `<policyPrefix>_rt_<channel>_<broadcast|presence>_<receive|send>`. Before creating them, `realtime.sql` drops every policy on `realtime.messages` whose name starts with `<policyPrefix>_rt_` and is no longer declared. Other policies are never touched.

## SDK

| Accessor | Returns |
| --- | --- |
| `client.<table>.subscribe(listener, { event?, filter?, onStatus? })` | `() => void` (unsubscribe). Only on `realtime: true` tables. |
| `client.channels.<name>(param)` / `client.channels.<name>()` | The provider's `RealtimeChannel`, private, for the topic. |
| `q.<table>.invalidateOnChange({ event?, filter? })` | `() => void`. With `reactQuery: true`; needs `queryClient`. |

Types exported by `client.ts`: `RealtimeEvent`, `RealtimeChange<Row>`, `RealtimeChangeOf<Row, Event>`, `RealtimeFilter<Row>`, `RealtimeSubscribeOptions<Row, Event>`, `ChannelOf<TClient>`. See [Generated SDK](/api/sdk#realtime).

A provider without `channel` / `removeChannel` (a test double, for example) makes `subscribe` and `channels.*` throw `[AccessNexus] ... needs a Supabase client with Realtime`.
