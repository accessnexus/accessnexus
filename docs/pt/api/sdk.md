# SDK gerado {#generated-sdk}

Um wrapper tipado sobre um client do supabase-js, gerado em `output.sdk` (padrão `./generated/sdk`) pelo `accessnexus generate`. O RLS continua valendo: toda chamada roda como o usuário logado do client encapsulado.

## Arquivos {#files}

| Modo | Arquivo | Conteúdo |
| --- | --- | --- |
| Manual | `types.ts` | Por tabela: `<Table>` (linha), `<Table>Create`, `<Table>Update`; e uma interface `Database` no formato do Supabase, incluindo `Functions` para cada RPC. |
| Manual | `client.ts` | `createAccessNexusClient`, `AccessNexusClient`. Importa de `./types.js`. |
| Database | `client.ts` | `createAccessNexusClient`, `AccessNexusClient`. Importa `Database` de `adapterOptions.databaseTypes` (padrão `'./database.types'`, relativo à pasta do SDK). |

`<Table>` é o nome da tabela em PascalCase (`org_members` vira `OrgMembers`). Os dois arquivos são derivados: nunca edite, gere de novo.

O `accessnexus init` também escreve ao lado deles um wrapper que cria o client do Supabase e exporta uma instância pronta: `index.ts` (exporta `accessnexus`) ou, no Next.js, `browser.ts` (exporta `accessnexus`) e `server.ts` (exporta `createServerAccessNexus()`). Esse wrapper é seu; o `generate` nunca mexe nele.

## Tipos gerados (modo manual) {#generated-types-manual-mode}

| Tipo | Definição |
| --- | --- |
| `<Table>` | Uma propriedade por coluna, tipada como em [tipos de coluna](/pt/api/schema#column-types). Colunas enum viram uma union dos seus valores. |
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

type AccessNexusClient = ReturnType<typeof createAccessNexusClient>;

// Formato frouxo que um client real do supabase-js satisfaz
type AccessNexusProvider = {
  auth: unknown;
  from: (table: any) => any;
  rpc: (name: any, args?: any) => any;
};
```

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `provider` | `AccessNexusProvider` | Um client do supabase-js (`createClient(...)`, `createBrowserClient(...)`, `createServerClient(...)`) ou qualquer objeto com `auth`, `from` e `rpc`. |

Internamente, o provider é usado por meio de um tipo estrito `AccessNexusTransport` (`from<T>(table)` retornando query builders tipados). Nem `AccessNexusProvider` nem `AccessNexusTransport` são exportados.

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
| `findMany` | `(filter?: Partial<Row>, options?: { include?: Include }) => QueryResult<Row[]>` | `from(t).select('*'[, joins])[.is(softDelete, null)].match(filter ?? {})` |
| `findById` | `(id: string, options?: { include?: Include }) => QueryResult<Row>` | `from(t).select('*'[, joins]).eq(<pk>, id)[.is(softDelete, null)].single()` |
| `create` | `(data: Create) => QueryResult<Row>` | `from(t).insert(data).select().single()` |
| `update` | `(id: string, data: Update) => QueryResult<Row>` | `from(t).update(data).eq(<pk>, id).select().single()` |
| `delete` | `(id: string) => QueryResult<Row[]>` | `from(t).delete().eq(<pk>, id)` |

```ts
type QueryResult<T> = Promise<{ data: T | null; error: unknown }>;
```

Tipos por modo:

| | Modo manual | Modo Database |
| --- | --- | --- |
| `Row` | `<Table>` | `Database['public']['Tables'][t]['Row']` |
| `Create` | `<Table>Create` | `...[t]['Insert']` |
| `Update` | `<Table>Update` | `...[t]['Update']` |

Observações:

- `filter` é passado para o `match` do supabase-js: igualdade em cada coluna informada, combinadas com AND. Para outros operadores, use diretamente o client do supabase-js encapsulado.
- `id` é tipado como `string` para qualquer tipo de primary key.
- `create` e `update` retornam a linha gravada (`INSERT/UPDATE ... RETURNING`), então a policy de `select` da tabela precisa admitir essa linha, ou a chamada falha com erro de RLS.
- `delete` envia um DELETE de verdade. Numa tabela com `softDelete`, o trigger transforma isso em `SET <column> = NOW()`, então quem decide é a policy de DELETE. O supabase-js retorna `data: null` para um delete sem `.select()`.
- Numa tabela com `softDelete`, `findMany` e `findById` adicionam `.is(<column>, null)`. O RLS em si não esconde linhas com soft delete.

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

No modo manual, `Functions` vem do `types.ts` gerado (uma RPC sem `args` recebe `{}`); no modo Database, do seu tipo `Database`.

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

`client.auth` é o objeto `auth` do provider, repassado sem alterações (`db.auth.signInWithPassword(...)`, `db.auth.getUser()`, ...). O tipo dele é o tipo de `auth` do provider.

## Dicas de tipagem {#typing-tips}

- Modo manual: importe os tipos de linha de `types.ts` (`import type { Posts, PostsCreate } from './generated/sdk/types.js'`).
- Modo Database: gere de novo o `database.types.ts` com a Supabase CLI depois de cada `push` e então rode `accessnexus generate`.
- `AccessNexusClient` é o tipo do client, para passá-lo adiante: `function load(db: AccessNexusClient) { ... }`.
