# Realtime {#realtime}

O Supabase Realtime tem duas partes, e o AccessNexus cobre as duas a partir do schema:

- **Postgres Changes**: os assinantes recebem inserts, updates e deletes de uma tabela. Você inclui a tabela com `realtime: true`; o Realtime só entrega uma linha a usuários cuja policy de SELECT a mostra.
- **Broadcast e Presence**: mensagens e "quem está online" num canal nomeado. Você declara canais privados com `channel()`; as regras deles viram policies de RLS em `realtime.messages`.

As duas terminam em `generated/policies/realtime.sql`, que o `push` aplica como qualquer arquivo de policies. O SDK ganha os acessores tipados `subscribe` e `channels`.

## Postgres Changes {#postgres-changes}

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

O `realtime.sql` adiciona a tabela à publication `supabase_realtime` (só se ela ainda não estiver lá) e define `REPLICA IDENTITY DEFAULT`:

```sql
ALTER PUBLICATION supabase_realtime ADD TABLE public.tasks;
ALTER TABLE public.tasks REPLICA IDENTITY DEFAULT;
```

| Valor | Efeito no push |
| --- | --- |
| `realtime: true` | Adiciona a tabela à publication. |
| `realtime: { replicaIdentity: 'full' }` | O mesmo, com `REPLICA IDENTITY FULL` (veja [linhas antigas](#old-rows-and-deletes)). |
| `realtime: false` | Remove a tabela da publication. |
| chave omitida | Não faz nada: uma tabela que você habilitou no dashboard continua habilitada. |

Um banco sem a publication `supabase_realtime` (Postgres puro) recebe um aviso do `push`, não um erro.

### Assinando pelo SDK {#subscribing-from-the-sdk}

Tabelas com `realtime: true` ganham `subscribe(listener, options?)`, que retorna uma função para cancelar a assinatura:

```ts
const stop = db.tasks.subscribe((change) => {
  if (change.eventType === 'INSERT') console.log('new task', change.new.title);
}, { filter: { project_id: projectId } });

// later
stop();
```

- `change` é tipado a partir da linha da tabela: `new` é a linha em INSERT/UPDATE, `old` traz a primary key.
- `event: 'INSERT' | 'UPDATE' | 'DELETE'` escuta um único evento e restringe o `change` (padrão `'*'`).
- `filter` roda no servidor do Realtime e nomeia exatamente uma coluna, como o Realtime permite: `{ project_id: id }` (eq), `{ status: ['todo', 'done'] }` (in), ou `{ views: { gt: 10 } }` (`eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `in`). Colunas desconhecidas e tipos de valor errados não compilam; duas colunas lançam erro.
- `onStatus(status, error?)` informa o status do canal (`SUBSCRIBED`, `CHANNEL_ERROR`, `TIMED_OUT`, `CLOSED`).

Com os [helpers do TanStack Query](/pt/api/sdk#tanstack-query-react-query) habilitados, `q.tasks.invalidateOnChange(options?)` invalida as queries da tabela (e das tabelas que a embutem via `include`) a cada mudança:

```tsx
useEffect(() => q.tasks.invalidateOnChange({ filter: { project_id: projectId } }), [projectId]);
```

### Linhas antigas e deletes {#old-rows-and-deletes}

O Supabase aplica o RLS ao Postgres Changes com estes limites, que valem para toda tabela que o AccessNexus gera (o RLS está sempre ligado):

- **Deletes não passam pelo filtro do RLS.** Todo assinante da tabela recebe os eventos DELETE, que carregam só a primary key da linha apagada. Não coloque segredos em primary keys. Filtros no servidor também não se aplicam a DELETE.
- **`old` contém só a primary key**, mesmo com `REPLICA IDENTITY FULL`. Por isso `replicaIdentity: 'full'` só faz sentido numa tabela com `enableRLS: false`; caso contrário o `validate` avisa `REALTIME_REPLICA_FULL_WITH_RLS`.
- Tabelas com soft delete enviam um UPDATE (o trigger define `deleted_at`), não um DELETE.

## Broadcast e Presence {#broadcast-and-presence}

Canais privados são autorizados por RLS em `realtime.messages`: uma policy de SELECT permite receber (mensagens de broadcast, estado de presence), e uma policy de INSERT permite enviar (broadcast) ou registrar a própria presença. Declare-os com `channel()` na opção `channels` do `defineSchema`:

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

### Tópico e tabela {#topic-and-table}

- `topic` é um nome fixo (`'announcements'`) ou um prefixo mais um parâmetro final (`'project:{id}'`). Apenas letras, dígitos e `:_.-`.
- Com `table`, o parâmetro é a primary key dessa tabela e **toda regra do canal também exige que o usuário consiga dar SELECT na linha**. A checagem roda como o usuário, então as policies da própria tabela decidem: um canal nunca é mais amplo que a linha a que pertence. Uma chave malformada (`project:not-a-uuid`) é negada, nunca vira erro.

### Regras {#rules}

Cada um de `broadcast` e `presence` aceita `receive` e `send`:

| Regra | Quem |
| --- | --- |
| `true` | Qualquer usuário autenticado (mais a checagem da linha quando `table` está definido). |
| `false` ou omitida | Ninguém: nenhuma policy é criada, e uma existente é removida. |
| `policy.isAuthenticated()`, `policy.public()`, `policy.none()`, `policy.hasRole(role)` | Como nas policies de tabela. `public()` admite usuários anônimos. |
| `policy.custom(sql)` | SQL cru em `realtime.messages`. `{param}` é o parâmetro do tópico como texto; `realtime.topic()` é o tópico inteiro. |
| `policy.any([...])`, `policy.all([...])` | Combinações das regras acima. |

Regras que leem colunas de uma linha de tabela (`isOwner`, `belongsTo`, `matchesField`, `withCheck`) não se aplicam a `realtime.messages`; o `validate` acusa `CHANNEL_RULE_NOT_SUPPORTED`. Use `table` para "usuários que podem ver esta linha", ou `policy.custom`.

### O que o push faz {#what-push-does}

O `realtime.sql` remove e recria as policies `<prefix>_rt_<channel>_<broadcast|presence>_<receive|send>`, e remove qualquer outra policy em `realtime.messages` cujo nome comece com `<prefix>_rt_`, então remover um canal ou uma regra revoga o acesso. Policies que você escreveu à mão com outro nome são deixadas em paz. `channels: {}` remove todas as policies de canal do prefixo.

### Entrando pelo SDK {#joining-from-the-sdk}

`client.channels.<name>(param)` retorna o `RealtimeChannel` do supabase-js para o tópico, criado como privado (`{ config: { private: true } }`), de modo que o Realtime checa as policies ao entrar, enviar e receber:

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

Tópicos fixos não recebem argumento: `db.channels.announcements()`. O client supabase-js envia o token do usuário autenticado ao Realtime. Num client de servidor sem sessão, chame `supabase.realtime.setAuth(token)` antes de entrar.

::: tip Só canais privados
No dashboard do Supabase (configurações de Realtime) você pode desativar "Allow public access", para que clients não contornem estas policies entrando num canal como público.
:::

## Verificações {#checks}

O `validate` acusa:

| Código | Severidade | Quando |
| --- | --- | --- |
| `INVALID_REALTIME` | error | `realtime` não é `true`, `false` nem `{ replicaIdentity }`. |
| `REALTIME_NOT_READABLE` | warning | Uma tabela publicada não tem policy de select: ninguém recebe as mudanças dela. |
| `REALTIME_RLS_DISABLED` | warning | Uma tabela publicada tem `enableRLS: false`: todo assinante, inclusive anon, recebe toda linha. |
| `REALTIME_REPLICA_FULL_WITH_RLS` | warning | `replicaIdentity: 'full'` com RLS ligado não tem efeito para os assinantes. |
| `INVALID_CHANNEL` | error | Tópico inválido, opção desconhecida, `table` sem `{param}` ou com chave composta, um `{placeholder}` que não é o parâmetro do tópico. |
| `CHANNEL_RULE_NOT_SUPPORTED` | error | Uma regra por linha (`isOwner`, `belongsTo`, ...) num canal. |
| `CHANNEL_TABLE_NOT_READABLE` | warning | A tabela do canal não tem policy de select, então ninguém consegue entrar. |
| `CHANNEL_PUBLIC_SEND` | warning | Usuários anônimos podem enviar. |
| `CHANNEL_CLOSED` | warning | O canal não concede nada. |

## Projetos existentes {#existing-projects}

O `init --db-url` importa as tabelas que já estão na publication `supabase_realtime` como `realtime: true` (`{ replicaIdentity: 'full' }` quando definido). As policies que já existem em `realtime.messages` são listadas num comentário, mas não importadas: o `push` as deixa como estão, porque só gerencia policies com nomes `<prefix>_rt_` próprios. Porte-as para `channels` para gerenciá-las pelo schema.

## Veja também {#related}

- [SDK gerado](/pt/api/sdk#realtime)
- [defineSchema / table](/pt/api/schema)
- [Modelo de segurança](/pt/guide/security#realtime-follows-the-same-policies)
