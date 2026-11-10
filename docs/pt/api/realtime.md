# channel / realtime {#channel-realtime}

Referência do Supabase Realtime no schema. Para o passo a passo, veja o [guia de Realtime](/pt/guide/realtime).

## realtime (opção de tabela) {#realtime-table-option}

```ts
type TableRealtime = boolean | { replicaIdentity?: 'default' | 'full' };
```

| Valor | SQL gerado (`realtime.sql`) | SDK |
| --- | --- | --- |
| `true` | `ALTER PUBLICATION supabase_realtime ADD TABLE public.<table>` (se faltar), `REPLICA IDENTITY DEFAULT` | `client.<table>.subscribe(...)` |
| `{ replicaIdentity: 'full' }` | O mesmo, com `REPLICA IDENTITY FULL` | `client.<table>.subscribe(...)` |
| `false` | `ALTER PUBLICATION supabase_realtime DROP TABLE public.<table>` (se presente) | nenhum |
| omitido | nada | nenhum |

Funciona nos modos manual e Database. Sem a publication `supabase_realtime`, o `push` imprime um aviso e não altera nada.

## channel {#channel}

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

Passe os canais para `defineSchema(tables, { channels: { <name>: channel({ ... }) } })`. Os nomes são snake_case em minúsculas, com até 40 caracteres.

| Opção | Descrição |
| --- | --- |
| `topic` | Um tópico fixo, ou um prefixo mais um `{param}` final. Letras, dígitos e `:_.-`. Um tópico que seja só `{param}` é rejeitado (casaria com todos os canais). |
| `table` | Exige um `{param}`. Toda regra passa a checar também `EXISTS (SELECT 1 FROM public.<table> WHERE <pk> = <param>)` como o usuário, então a policy de SELECT da tabela decide. Chaves `uuid` e inteiras são comparadas sem um cast que possa falhar; um parâmetro malformado não casa com nada. |
| `broadcast.receive` | Receber mensagens de broadcast. |
| `broadcast.send` | Enviar mensagens de broadcast. |
| `presence.receive` | Ver o estado de presence. |
| `presence.send` | Registrar a própria presença. |

### Regras {#rules}

| Regra | Role da policy | Condição |
| --- | --- | --- |
| `true` | `authenticated` | `(SELECT auth.uid()) IS NOT NULL` |
| `false`, omitida, `policy.none()` | nenhuma | nenhuma policy (uma existente é removida) |
| `policy.isAuthenticated()` | `authenticated` | `(SELECT auth.uid()) IS NOT NULL` |
| `policy.public()` | `public` | `TRUE` |
| `policy.hasRole(role)` | `authenticated` | a claim `app_metadata.role` é igual a `role` |
| `policy.custom(sql)` | `public` | `sql`, com `{param}` substituído pelo parâmetro do tópico (texto) |
| `policy.any` / `policy.all` | a mais ampla / a mais restrita das partes | OR / AND |

Toda condição também é combinada com AND com a extensão (`realtime.messages.extension = 'broadcast' | 'presence'`), a correspondência do tópico e, com `table`, a checagem da linha.

### Policies geradas {#generated-policies}

Uma policy por extensão concedida e por ação, em `realtime.messages`:

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

Os nomes são `<policyPrefix>_rt_<channel>_<broadcast|presence>_<receive|send>`. Antes de criá-las, o `realtime.sql` remove toda policy em `realtime.messages` cujo nome comece com `<policyPrefix>_rt_` e que não esteja mais declarada. Outras policies nunca são tocadas.

## SDK {#sdk}

| Acessor | Retorna |
| --- | --- |
| `client.<table>.subscribe(listener, { event?, filter?, onStatus? })` | `() => void` (cancela a assinatura). Só em tabelas com `realtime: true`. |
| `client.channels.<name>(param)` / `client.channels.<name>()` | O `RealtimeChannel` do provider, privado, para o tópico. |
| `q.<table>.invalidateOnChange({ event?, filter? })` | `() => void`. Com `reactQuery: true`; precisa de `queryClient`. |

Tipos exportados pelo `client.ts`: `RealtimeEvent`, `RealtimeChange<Row>`, `RealtimeChangeOf<Row, Event>`, `RealtimeFilter<Row>`, `RealtimeSubscribeOptions<Row, Event>`, `ChannelOf<TClient>`. Veja [SDK gerado](/pt/api/sdk#realtime).

Um provider sem `channel` / `removeChannel` (um test double, por exemplo) faz `subscribe` e `channels.*` lançarem `[AccessNexus] ... needs a Supabase client with Realtime`.
