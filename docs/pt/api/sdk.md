# SDK gerado {#generated-sdk}

Um wrapper tipado sobre um client do supabase-js, gerado em `output.sdk` (padrão `./generated/sdk`) pelo `accessnexus generate`. O RLS continua valendo: toda chamada roda como o usuário logado do client encapsulado.

## Arquivos {#files}

| Modo | Arquivo | Conteúdo |
| --- | --- | --- |
| Manual | `types.ts` | `Json`; por tabela: `<Table>` (linha), `<Table>Create`, `<Table>Update`; e uma interface `Database` no formato do Supabase, incluindo `Functions` para cada RPC. |
| Manual | `client.ts` | `createAccessNexusClient`, `AccessNexusClient`, `AccessNexusProvider`, `ColumnsOf`, `SelectedRow`; reexporta `Json`. Importa de `./types.js`. |
| Database | `client.ts` | `createAccessNexusClient`, `AccessNexusClient`, `AccessNexusProvider`, `ColumnsOf`, `SelectedRow`. Importa `Database` de `adapterOptions.databaseTypes` (padrão `'./database.types'`, relativo à pasta do SDK). |

`<Table>` é o nome da tabela em PascalCase (`org_members` vira `OrgMembers`). Os dois arquivos são derivados: nunca edite, gere de novo.

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
| `update` | `(id: string, data: Update) => QueryResult<Row>` | `from(t).update(data).eq(<pk>, id).select().single()` |
| `delete` | `(id: string) => QueryResult<null>` | `from(t).delete().eq(<pk>, id)` |
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
- `delete` envia um DELETE de verdade. Numa tabela com `softDelete`, o trigger transforma isso em `SET <column> = NOW()`, então quem decide é a policy de DELETE. O supabase-js retorna `data: null` para um delete sem `.select()`.
- `findOne` e `findById` usam `maybeSingle()`: nenhuma linha (ou nenhuma visível) é `{ data: null, error: null }`, não um erro. Mais de uma linha batendo com o filtro do `findOne` é erro (PGRST116), então filtre por uma coluna única (`{ slug }`, `{ email }`).
- Numa tabela com `softDelete`, `findMany`, `findOne` e `findById` adicionam `.is(<column>, null)`. O RLS em si não esconde linhas com soft delete.

### Escritas por filtro {#filtered-writes}

`updateOne` / `updateMany` / `deleteOne` / `deleteMany` gravam por um filtro em vez da primary key, numa só ida ao servidor, e retornam as linhas gravadas:

```ts
import { createClient } from '@supabase/supabase-js';
import { createAccessNexusClient } from './generated/sdk/client.js';

const db = createAccessNexusClient(createClient('https://xyz.supabase.co', 'public-anon-key'));

export async function publish(slug: string) {
  // uma coluna única que não é PK: uma requisição, a linha atualizada (ou null)
  const { data, error } = await db.posts.updateOne({ slug }, { published: true }, { columns: ['id', 'slug'] });
  if (error) throw error;
  return data; // Pick<Posts, 'id' | 'slug'> | null
}
```

- O filtro é obrigatório e tipado como `RowFilter<T, TFilter>` (exportado pelo client gerado): as chaves precisam ser colunas, os valores os tipos das colunas, e `{}` é erro de tipo. Em runtime, um filtro vazio, ou com todos os valores `undefined`, lança `[AccessNexus] <table>.<method>: the filter must name at least one column (refusing to write every row)` antes de qualquer requisição. `data` é o tipo `Update` da tabela.
- `updateOne` / `deleteOne` usam `maybeSingle()`: nenhuma linha visível batendo é `{ data: null, error: null }`. Mais de uma é erro PGRST116 e o PostgREST desfaz a escrita.
- As linhas retornadas vêm do `.select()` (`UPDATE/DELETE ... RETURNING`), então só voltam quando a policy de `select` deixa o usuário vê-las. `options.columns` as restringe como no `findOne`.
- Numa tabela com `softDelete`, esses métodos só tocam linhas vivas (`.is(<column>, null)`). O trigger transforma o DELETE em UPDATE, então o DELETE não retorna linha: `deleteOne` dá `null` e `deleteMany` `[]`, mesmo com as linhas tendo sofrido soft delete.

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

## Dicas de tipagem {#typing-tips}

- Modo manual: importe os tipos de linha de `types.ts` (`import type { Posts, PostsCreate } from './generated/sdk/types.js'`).
- Modo Database: os tipos de linha são `Database['public']['Tables'][t]['Row' | 'Insert' | 'Update']` do seu próprio arquivo, idênticos aos do Supabase. Gere de novo o `database.types.ts` com a Supabase CLI depois de cada `push` e então rode `accessnexus generate`.
- `AccessNexusClient<SupabaseClient<Database>>` é o tipo do client, para passá-lo adiante: `function load(db: AccessNexusClient<SupabaseClient<Database>>) { ... }`. `AccessNexusClient` sem o argumento também funciona, com `auth: unknown`.
