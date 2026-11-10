# SDK gerado {#generated-sdk}

Um wrapper tipado sobre um client do supabase-js, gerado em `output.sdk` (padrão `./generated/sdk`) pelo `accessnexus generate`. O RLS continua valendo: toda chamada roda como o usuário logado do client encapsulado.

## Arquivos {#files}

| Modo | Arquivo | Conteúdo |
| --- | --- | --- |
| Manual | `types.ts` | `Json`; por tabela: `<Table>` (linha), `<Table>Create`, `<Table>Update`; e uma interface `Database` no formato do Supabase, incluindo `Functions` para cada RPC. |
| Manual | `client.ts` | `createAccessNexusClient`, `AccessNexusClient`, `AccessNexusProvider`, `ColumnsOf`, `SelectedRow`; reexporta `Json`. Importa de `./types.js`. |
| Database | `client.ts` | `createAccessNexusClient`, `AccessNexusClient`, `AccessNexusProvider`, `ColumnsOf`, `SelectedRow`. Importa `Database` de `adapterOptions.databaseTypes` (padrão `'./database.types'`, relativo à pasta do SDK). |
| Ambos, com `adapterOptions.reactQuery: true` | `react-query.ts` | `createAccessNexusQueries`, `AccessNexusQueries`, `accessNexusKeys`. Helpers do TanStack Query v5 sobre o client; veja [TanStack Query](#tanstack-query-react-query). |

`<Table>` é o nome da tabela em PascalCase (`org_members` vira `OrgMembers`). Esses arquivos são derivados: nunca edite, gere de novo.

O `accessnexus init` também escreve ao lado deles um wrapper que cria o client do Supabase e exporta uma instância pronta: `index.ts` (exporta `accessnexus`) ou, no Next.js, `browser.ts` (exporta `accessnexus`) e `server.ts` (exporta `createServerAccessNexus()`). Esse wrapper é seu; o `generate` nunca mexe nele.

## Tipos gerados (modo manual) {#generated-types-manual-mode}

| Tipo | Definição |
| --- | --- |
| `Json` | `string \| number \| boolean \| null \| { [key: string]: Json \| undefined } \| Json[]`, idêntico ao `Json` do `supabase gen types`. Usado em colunas `json`/`jsonb` e em args/retornos de RPC. |
| `<Table>` | Um type alias (não uma interface) com uma propriedade por coluna, tipada como em [tipos de coluna](/pt/api/schema#column-types): `\| null` quando nullable, `string` para uuid/text/datas/timestamps, `number` para numéricos, `Json` para json/jsonb, colunas enum como union dos seus valores. É o formato que o `supabase gen types` produz para a mesma tabela, então as linhas são atribuíveis nos dois sentidos, e o `Database` gerado pode ser passado para `createClient<Database>()`. |
| `<Table>Create` | Obrigatórias: colunas não nulas sem `default`. Opcionais: colunas nullable, colunas com `default` e uma primary key `uuid` ou `bigint`. |
| `<Table>Update` | `Partial<Omit<<Table>, '<primaryKey>'>>` |
| `Database` | `{ public: { Tables: { <table>: { Row; Insert; Update; Relationships: [] } }; Views; Functions: { <rpc>: { Args; Returns } }; Enums; CompositeTypes } }` |

O `Args` de uma RPC é montado a partir de `args` (`{}` quando não há nenhum); o `Returns`, a partir de `returns` (`unknown` quando omitido ou `'void'`).

## createAccessNexusClient

```ts
function createAccessNexusClient<TClient extends AccessNexusProvider>(provider: TClient): {
  auth: TClient['auth'];
  [table: string]: TableAccessors;   // uma propriedade por tabela
  rpc: { [name: string]: (args) => Promise<{ data; error }> }; // só quando o schema tem RPCs
};

type AccessNexusClient<TClient extends AccessNexusProvider = AccessNexusProvider> =
  ReturnType<typeof createAccessNexusClient<TClient>>;

// Formato frouxo que um client real do supabase-js satisfaz
type AccessNexusProvider = {
  auth: unknown;
  from(table: string): unknown;
  rpc(name: string, args?: object): unknown;
};
```

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `provider` | `AccessNexusProvider` | Um client do supabase-js (`createClient(...)`, `createBrowserClient(...)`, `createServerClient(...)`) ou qualquer objeto com `auth`, `from` e `rpc`. |

A factory é genérica sobre o provider, então `auth` mantém o tipo do provider: com `createBrowserClient<Database>()` / `createServerClient()` do `@supabase/ssr` ou `createClient()` do `@supabase/supabase-js`, `db.auth.signInWithOAuth(...)` fica totalmente tipado. Para nomear o tipo do client, passe o tipo do provider: `AccessNexusClient<SupabaseClient<Database>>` (sem ele, `auth` é `unknown`). Internamente o provider é usado por uma visão frouxa do query builder; cada método converte o resultado para o tipo documentado.

::: tip Caminho do import
Os exemplos importam `./client.js` (ESM NodeNext). Em projetos Next.js, Vite e outros com bundler, importe `./client` sem extensão — o Turbopack não consegue mapear `./client.js` para `client.ts`. Os wrappers que o `init` escreve já seguem o seu projeto: sem extensão nos frameworks com bundler (ou num tsconfig com `moduleResolution: "bundler"`), `.js` em Node puro.
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

## Métodos de tabela {#table-methods}

Toda tabela do schema ganha estes acessores. `<pk>` é a `primaryKey` da tabela (ou `id`).

| Método | Assinatura | Query enviada |
| --- | --- | --- |
| `findMany` | `(filter?: Partial<Row>, options?: { columns?; include? }) => QueryResult<Selected[]>` | `from(t).select(<colunas ou *>[, joins])[.is(softDelete, null)].match(filter ?? {})` |
| `findOne` | `(filter: Partial<Row>, options?: { columns?; include? }) => QueryResult<Selected>` | `from(t).select(<colunas ou *>[, joins])[.is(softDelete, null)].match(filter).maybeSingle()` |
| `findById` | `(id: string, options?: { columns?; include? }) => QueryResult<Selected>` | `from(t).select(<colunas ou *>[, joins]).eq(<pk>, id)[.is(softDelete, null)].maybeSingle()` |
| `create` | `(data: Create) => QueryResult<Row>` | `from(t).insert(data).select().single()` |
| `update` | `(id: string, data: Update) => QueryResult<Row>` | `from(t).update(data).eq(<pk>, id).select().maybeSingle()`; nenhuma linha alterada é [`ACCESSNEXUS_NOT_FOUND_OR_DENIED`](#errors) |
| `delete` | `(id: string) => QueryResult<null>` | `from(t).delete({ count: 'exact' }).eq(<pk>, id)`; nada apagado é [`ACCESSNEXUS_NOT_FOUND_OR_DENIED`](#errors) |
| `updateOne` | `(filter: RowFilter, data: Update, options?: { columns? }) => QueryResult<Selected>` | `from(t).update(data).match(filter)[.is(softDelete, null)].select(<colunas ou *>).maybeSingle()` |
| `updateMany` | `(filter: RowFilter, data: Update, options?: { columns? }) => QueryResult<Selected[]>` | `from(t).update(data).match(filter)[.is(softDelete, null)].select(<colunas ou *>)` |
| `deleteOne` | `(filter: RowFilter, options?: { columns? }) => QueryResult<Selected>` | `from(t).delete().match(filter)[.is(softDelete, null)].select(<colunas ou *>).maybeSingle()` |
| `deleteMany` | `(filter: RowFilter, options?: { columns? }) => QueryResult<Selected[]>` | `from(t).delete().match(filter)[.is(softDelete, null)].select(<colunas ou *>)` |

`Selected` é `Row` (mais as relações do `include`), ou `Pick<Row, ...columns>` quando `columns` é informado.

```ts
type QueryResult<T> = Promise<{ data: T | null; error: unknown }>;
```

Tipos por modo:

| | Modo manual | Modo Database |
| --- | --- | --- |
| `Row` | `<Table>` | `Database['public']['Tables'][t]['Row']` |
| `Create` | `<Table>Create` | `...[t]['Insert']` |
| `Update` | `<Table>Update` | `...[t]['Update']` |
| `RowFilter` | `{ [coluna]?: tipo da coluna }`, ao menos uma chave | igual, a partir do `Row` |

Observações:

- `filter` é passado para o `match` do supabase-js: igualdade em cada coluna informada, combinadas com AND. Para outros operadores, use diretamente o client do supabase-js encapsulado.
- `id` é tipado como `string` para qualquer tipo de primary key.
- `create` e `update` retornam a linha gravada (`INSERT/UPDATE ... RETURNING`), então a policy de `select` da tabela precisa admitir essa linha, ou a chamada falha com erro de RLS.
- `delete` envia um DELETE de verdade e pede a contagem de linhas afetadas, então um delete que não removeu nada é um erro (veja [Erros](#errors)). Numa tabela com `softDelete`, o trigger transforma isso em `SET <column> = NOW()`, então quem decide é a policy de DELETE; o SDK confere a linha viva antes e depois (sumiu significa apagada). `data` é `null` em caso de sucesso.
- `findOne` e `findById` usam `maybeSingle()`: nenhuma linha (ou nenhuma visível) é `{ data: null, error: null }`, não um erro. Mais de uma linha batendo com o filtro do `findOne` é erro (PGRST116), então filtre por uma coluna única (`{ slug }`, `{ email }`).
- Numa tabela com `softDelete`, `findMany`, `findOne` e `findById` adicionam `.is(<column>, null)`. O RLS em si não esconde linhas com soft delete.

### Escritas por filtro {#filtered-writes}

`updateOne` / `updateMany` / `deleteOne` / `deleteMany` gravam por um filtro em vez da primary key, numa só ida ao servidor, e retornam as linhas gravadas:

```ts
import { createClient } from '@supabase/supabase-js';
import { createAccessNexusClient } from './generated/sdk/client.js';

const db = createAccessNexusClient(createClient('https://xyz.supabase.co', 'public-anon-key'));

export async function publish(slug: string) {
  // uma coluna única que não é PK: uma requisição, a linha atualizada (um erro quando nada mudou)
  const { data, error } = await db.posts.updateOne({ slug }, { published: true }, { columns: ['id', 'slug'] });
  if (error) throw error;
  return data; // Pick<Posts, 'id' | 'slug'> | null (null só junto com um erro)
}
```

- O filtro é obrigatório e tipado como `RowFilter<T, TFilter>` (exportado pelo client gerado): as chaves precisam ser colunas, os valores os tipos das colunas, e `{}` é erro de tipo. Em runtime, um filtro vazio, ou com todos os valores `undefined`, lança `[AccessNexus] <table>.<method>: the filter must name at least one column (refusing to write every row)` antes de qualquer requisição. `data` é o tipo `Update` da tabela.
- `updateOne` / `deleteOne` usam `maybeSingle()`. Nenhuma linha alterada (inexistente, escondida pelo RLS ou sem permissão de escrita) é um erro `ACCESSNEXUS_NOT_FOUND_OR_DENIED`, nunca `data: null` (veja [Erros](#errors)). Mais de uma linha batendo é erro PGRST116 e o PostgREST desfaz a escrita. `updateMany` / `deleteMany` continuam retornando `[]` quando nada bate.
- As linhas retornadas vêm do `.select()` (`UPDATE/DELETE ... RETURNING`), então só voltam quando a policy de `select` deixa o usuário vê-las. `options.columns` as restringe como no `findOne`.
- Numa tabela com `softDelete`, esses métodos só tocam linhas vivas (`.is(<column>, null)`). O trigger transforma o DELETE em UPDATE, então o DELETE em si não retorna linha: `deleteOne` retorna a linha como era antes (o SDK a lê primeiro) e `deleteMany` retorna `[]`, mesmo com as linhas tendo sofrido soft delete.

### columns

`options.columns` é um array de nomes de coluna. Envia `select('a, b')` em vez de `select('*')` e estreita o resultado para `Pick<Row, 'a' | 'b'>`. Os nomes são checados em tempo de compilação contra as colunas da tabela (`ColumnsOf<'tabela'>`): um nome desconhecido é erro de tipo. Em runtime os nomes passam como vieram; um array vazio seleciona `*`. Combina com `include` (os embeds são acrescentados).

```ts
import { createClient } from '@supabase/supabase-js';
import { createAccessNexusClient } from './generated/sdk/client.js';

const db = createAccessNexusClient(createClient('https://xyz.supabase.co', 'public-anon-key'));

export async function lookup(slug: string) {
  // data: Pick<Posts, 'id' | 'title'> | null — null (sem erro) quando nenhum post tem esse slug
  const { data: post } = await db.posts.findOne({ slug }, { columns: ['id', 'title'] });
  // db.posts.findMany({}, { columns: ['nope'] }) não compila
  return post?.title;
}
```

### include

Tabelas com foreign keys para outras tabelas do schema aceitam `options.include`, que embute a linha referenciada via PostgREST:

| Item | Valor |
| --- | --- |
| Origem | o mapa `references` no nível da tabela, entradas no formato `'table.column'` cuja tabela está no schema. `ColumnDef.references` no nível da coluna e referências externas (`auth.users.id`) não entram. |
| Alias | o nome da coluna sem o `_id` final (`author_id` vira `author`); deduplicado com um sufixo em caso de colisão |
| Embed | `<alias>:<target>!<table>_<column>_fkey(*)` |
| Tipo do resultado | `Row & { <alias>: TargetRow \| null }` para cada alias definido como `true` |

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

## Erros {#errors}

Os resultados são `{ data, error }`, como no supabase-js. O RLS recusa algumas escritas com um erro e outras em silêncio, tocando zero linhas. O SDK transforma os casos silenciosos em erro, então uma escrita nunca "dá certo" sem alterar nada. A tabela completa de como cada comando é recusado está em [Como uma negação aparece](/pt/guide/testing#how-a-denial-shows).

### ACCESSNEXUS_NOT_FOUND_OR_DENIED {#accessnexus-not-found-or-denied}

`update(id)`, `delete(id)`, `updateOne` e `deleteOne` retornam este erro quando nenhuma linha foi alterada: a linha não existe, o RLS a esconde, ou o RLS não deixa este usuário alterá-la. O SDK não consegue distinguir os casos (e não deve: revelaria linhas que o usuário não pode ver).

```ts
type AccessNexusError = {
  code: 'ACCESSNEXUS_NOT_FOUND_OR_DENIED';
  message: string;
  details: { table: string; method: string; id?: unknown; filter?: Record<string, unknown> };
  hint: string;
};
```

| Método | `details` |
| --- | --- |
| `update(id)`, `delete(id)` | `{ table, method, id }` |
| `updateOne`, `deleteOne` | `{ table, method, filter }` |

- `delete(id)` pede a contagem de linhas afetadas. Numa tabela com `softDelete`, confere a linha viva antes e depois do DELETE; uma linha que saiu do conjunto de linhas vivas conta como apagada.
- `updateMany` e `deleteMany` não mudam: retornam `[]` quando nada bate.
- As mutations do React Query lançam este erro como qualquer outro.
- Antes deste erro existir, `delete` reportava sucesso, `update` retornava um `PGRST116` cru e `updateOne` / `deleteOne` retornavam `data: null`.

### Helpers {#helpers}

O `client.ts` exporta estes, para o app não comparar códigos na mão:

| Export | Retorna `true` quando |
| --- | --- |
| `NOT_FOUND_OR_DENIED` | (constante) a string `'ACCESSNEXUS_NOT_FOUND_OR_DENIED'`. |
| `isNotFoundOrDenied(error)` | o erro é o `ACCESSNEXUS_NOT_FOUND_OR_DENIED` do SDK. |
| `isAccessDenied(error)` | o banco recusou a requisição: `isNotFoundOrDenied`, ou SQLSTATE `42501` (um INSERT ou `WITH CHECK` rejeitado pelo RLS, uma coluna travada, uma checagem de RPC definer). |
| `isLockedColumn(error)` | um guard de [`trigger.lockColumns`](/pt/api/trigger#lockcolumns) recusou o update: SQLSTATE `42501` com um HINT começando com `accessnexus:locked_column:` (`<table>.<column>`). |

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

## Chamadas de RPC {#rpc-calls}

Quando o schema declara RPCs, o client tem um namespace `rpc` com um método por RPC:

```ts
rpc.<name>(args: Functions['<name>']['Args']): QueryResult<Functions['<name>']['Returns']>
// chama provider.rpc('<name>', args)
```

No modo manual, `Functions` vem do `types.ts` gerado (uma RPC sem `args` recebe `{}`; um retorno `{ table }` / `{ setof }` é um array de linhas, veja [Tipos de retorno](/pt/api/rpc#return-types)); no modo Database, do seu tipo `Database`.

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

`client.auth` é o objeto `auth` do provider, repassado sem alterações (`db.auth.signInWithPassword(...)`, `db.auth.signInWithOAuth(...)`, `db.auth.getUser()`, ...). O tipo dele é `TClient['auth']`, o próprio tipo de `auth` do provider (`SupabaseAuthClient` para um client do supabase-js ou do @supabase/ssr).

## Realtime {#realtime}

Tabelas com `realtime: true` ganham `subscribe`, e os canais declarados com [`channel()`](/pt/api/realtime#channel) aparecem em `client.channels`. Veja o [guia de Realtime](/pt/guide/realtime).

```ts
const stop = db.tasks.subscribe((change) => {
  // change.eventType: 'INSERT' | 'UPDATE' | 'DELETE'; change.new is a Tasks row
}, { event: '*', filter: { project_id: projectId }, onStatus: (status) => console.log(status) });
stop(); // unsubscribe (removes the channel)

const room = db.channels.project_room(projectId); // supabase-js RealtimeChannel, private
room.on('broadcast', { event: 'cursor' }, ({ payload }) => draw(payload)).subscribe();
```

| Opção do `subscribe` | Tipo | Descrição |
| --- | --- | --- |
| `event` | `'INSERT' \| 'UPDATE' \| 'DELETE' \| '*'` | Evento a ouvir (padrão `'*'`); restringe o `change` do listener. |
| `filter` | `RealtimeFilter<Row>` | Uma coluna: um valor (eq), um array (in), ou `{ eq \| neq \| lt \| lte \| gt \| gte \| in }`. Duas colunas ou `null` lançam erro. Ignorado pelo Realtime em DELETE. |
| `onStatus` | `(status, error?) => void` | `SUBSCRIBED`, `CHANNEL_ERROR`, `TIMED_OUT`, `CLOSED`. |

`change` é `RealtimeChange<Row>`: `{ eventType, new, old, schema, table, commit_timestamp, errors }`, em que `new` é a linha em INSERT/UPDATE (vazio em DELETE) e `old` traz a primary key (tabelas com RLS não enviam mais que isso). `client.channels.<name>(param)` retorna `ChannelOf<TClient>`: o tipo `RealtimeChannel` do client Supabase que você passou.

## Edge Functions {#edge-functions}

As funções declaradas com [`edgeFunction()`](/pt/api/edge-functions) aparecem em `client.functions`, em camelCase (`invite-member` → `inviteMember`). Veja o [guia de Edge Functions](/pt/guide/edge-functions).

```ts
const { data, error } = await db.functions.inviteMember({ org_id: orgId, email, role: 'member' });
// data: InviteMemberOutput | null; on failure: await error.context.json() → { error: { code, message, issues? } }
```

Cada chamada é `supabase.functions.invoke('<name>', { body: input, method: 'POST', headers?, region? })`, então o JWT do usuário autenticado vai junto. O `client.ts` exporta `<Name>Input`, `<Name>Output` e `FunctionInvokeOptions`.

## TanStack Query (React Query) {#tanstack-query-react-query}

Com `adapterOptions: { reactQuery: true }`, o `generate` também escreve `react-query.ts` ao lado do `client.ts`: query keys, `queryOptions` para cada leitura e opções de mutation para cada escrita e RPC, encapsulando o client gerado. Ele precisa do `@tanstack/react-query` v5 no seu app (`npm i @tanstack/react-query`); o AccessNexus em si não depende dele. O arquivo é o mesmo no modo manual e no Database mode.

```tsx
import { QueryClient, useMutation, useQuery } from '@tanstack/react-query';
import { createAccessNexusQueries } from './generated/sdk/react-query.js';
import { accessnexus } from './generated/sdk/index.js'; // seu wrapper do init

export const queryClient = new QueryClient();
export const q = createAccessNexusQueries(accessnexus, { queryClient });

export function Tasks({ projectId }: { projectId: string }) {
  const tasks = useQuery(q.tasks.findMany({ project_id: projectId }, { columns: ['id', 'title'] }));
  const create = useMutation(q.tasks.create()); // invalida tasks (e tabelas que embutem tasks)
  // tasks.data: Pick<Tasks, 'id' | 'title'>[] | undefined
  return null;
}
```

| Helper | Retorna | Observações |
| --- | --- | --- |
| `q.<table>.findMany / findOne / findById(...)` | `queryOptions({ queryKey, queryFn })` | Mesmos argumentos e generics do client (`columns` e `include` restringem `data`). Funciona com `useQuery`, `useSuspenseQuery`, `prefetchQuery`, `getQueryData(...queryKey)`. |
| `q.<table>.create / update / delete / updateOne / updateMany / deleteOne / deleteMany()` | `{ mutationKey, mutationFn, onSuccess }` | Variáveis: `create(row)`, `update({ id, data })`, `delete(id)`, `updateOne/updateMany({ filter, data })`, `deleteOne/deleteMany(filter)`. A proteção de filtro vazio do client continua lançando erro. |
| `q.rpc.<name>.query(args)` / `q.rpc.<name>.mutation()` | opções de query / mutation | Use `query` para leituras e `mutation` para escritas (ela invalida todas as queries do AccessNexus). |
| `q.<table>.invalidateOnChange({ event?, filter? })` | `() => void` | Só em tabelas com `realtime: true`: assina e invalida a tabela (e as tabelas que a embutem) a cada mudança. Precisa de `queryClient`. Use num effect: `useEffect(() => q.tasks.invalidateOnChange(), [])`. |
| `q.functions.<name>.query(input)` / `q.functions.<name>.mutation()` | opções de query / mutation | Edge Functions; a mutation invalida todas as queries do AccessNexus. |
| `accessNexusKeys` | fábrica de keys | `accessNexusKeys.<table>.all` = `['accessnexus', '<table>']`; `list`, `one`, `byId` e `rpc.<name>` abaixo dela. |

- O `queryFn` transforma `{ data, error }` em valor ou rejeição: o `error` é lançado como veio (o `PostgrestError` do Supabase, com `code` / `message` / `details`). Listas resolvem para `[]` em vez de `null`; `findOne` / `findById` resolvem para `null` quando nenhuma linha visível bate. Uma RPC `RETURNS TABLE` / `SETOF` (query e mutation) resolve para `Row[]`, nunca `null`. As mutations `update`, `delete`, `updateOne` e `deleteOne` lançam `ACCESSNEXUS_NOT_FOUND_OR_DENIED` quando nenhuma linha mudou (veja [Erros](#errors)).
- Passe `queryClient` para ter invalidação: no sucesso, uma escrita invalida a própria tabela e toda tabela cujas queries podem embuti-la via `include`; uma mutation de RPC invalida todas as queries do AccessNexus. Sem `queryClient`, nada é invalidado.
- Acrescente suas opções com spread: `useQuery({ ...q.tasks.findById(id), enabled: !!id })`, `useMutation({ ...q.tasks.update(), onError })`. Um `onSuccess` seu substitui o gerado; nesse caso chame `queryClient.invalidateQueries({ queryKey: accessNexusKeys.tasks.all })` você mesmo.
- O RLS continua valendo: as queries rodam como o usuário do client Supabase encapsulado. No servidor, crie um `QueryClient` por request.

## Dicas de tipagem {#typing-tips}

- Modo manual: importe os tipos de linha de `types.ts` (`import type { Posts, PostsCreate } from './generated/sdk/types.js'`).
- Modo Database: os tipos de linha são `Database['public']['Tables'][t]['Row' | 'Insert' | 'Update']` do seu próprio arquivo, idênticos aos do Supabase. Gere de novo o `database.types.ts` com a Supabase CLI depois de cada `push` e então rode `accessnexus generate`.
- `AccessNexusClient<SupabaseClient<Database>>` é o tipo do client, para passá-lo adiante: `function load(db: AccessNexusClient<SupabaseClient<Database>>) { ... }`. `AccessNexusClient` sem o argumento também funciona, com `auth: unknown`.
