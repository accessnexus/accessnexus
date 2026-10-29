# defineSeed / defineConfig

`defineSeed` declara dados de desenvolvimento para o `accessnexus seed`; `defineConfig` declara as configurações do projeto no `accessnexus.config.ts`. Guias: [Seed](/pt/guide/seed), [CLI](/pt/guide/cli).

## defineSeed

```ts
// Modo manual: nomes de tabela conferidos contra o schema
function defineSeed<T extends SchemaDef>(schema: T, data: SeedDataFromSchema<T>): SeedDef;

// Modo Database: linhas tipadas pelo seu tipo Database do Supabase
function defineSeed<DB extends SupabaseDatabase>(data: SeedDataFromDatabase<DB>): SeedDef;

type SeedDataFromSchema<T> = { [K in keyof T]?: Array<Record<string, unknown>> };
type SeedDataFromDatabase<DB> = { [K in TableNamesOf<DB>]?: Array<InsertOf<DB, K>> };
type SeedDef = Record<string, Array<Record<string, unknown>>>;
```

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `schema` | `SchemaDef` | O default export do seu arquivo de schema. Usado só para tipagem: as chaves de tabela de `data` precisam ser tabelas do schema. Os campos das linhas não são tipados no modo manual. |
| `data` | object | Nome da tabela para um array de linhas. No modo Database, cada linha é o tipo `Insert` da tabela. |

Retorna `data` sem alterações. Faça o default export dele no arquivo de seed (caminho padrão `./accessnexus.seed.ts`, ou `seed` na config, ou `--seed <path>`).

```ts
import { defineSeed } from 'accessnexus';
import schema from './accessnexus.schema.js';

export default defineSeed(schema, {
  profiles: [
    { id: '00000000-0000-0000-0000-000000000001', name: 'Admin', email: 'admin@example.com' },
  ],
  posts: [
    { author_id: '00000000-0000-0000-0000-000000000001', title: 'Hello', status: 'published' },
  ],
});
```

```ts
import { defineSeed } from 'accessnexus';
import type { Database } from './database.types.js';

export default defineSeed<Database>({
  profiles: [{ id: '00000000-0000-0000-0000-000000000001' }],
});
```

### SQL de seed gerado {#generated-seed-sql}

| Comportamento | Detalhe |
| --- | --- |
| Ordem | Tabelas na ordem de dependência das foreign keys; tabelas fora do schema por último. Arrays vazios são ignorados. |
| Statement | `INSERT INTO "<table>" ("c1", ...) VALUES (...) ON CONFLICT ("<pk>") DO UPDATE SET "c" = EXCLUDED."c", ...` (`DO NOTHING` quando a linha só tem a primary key). Rodar de novo é seguro. |
| Primary key | `primaryKey`, ou `id` quando a tabela não define uma. |
| Valores | `null`/`undefined` viram `NULL`; números e booleanos como literais; objetos e arrays como JSON entre aspas; todo o resto como string entre aspas. |
| Transação | O seed inteiro roda numa transação só; uma falha desfaz tudo (`SEED_FAILED`). |

### Usuários de auth {#auth-users}

Para cada tabela do seed cujo mapa `references` no nível da tabela aponta uma coluna exatamente para `'auth.users.id'`, o seed primeiro insere em `auth.users` cada valor distinto dessa coluna (`ON CONFLICT (id) DO NOTHING`), com `email_confirmed_at = NOW()` e o campo `email` da linha como e-mail (ou `NULL`).

| Origem da senha | Resultado |
| --- | --- |
| `ACCESSNEXUS_SEED_PASSWORD` definida | todo usuário provisionado recebe essa senha (com hash via `crypt(..., gen_salt('bf'))`) |
| não definida | uma senha aleatória e impossível de descobrir para cada usuário |

Um `references: 'auth.users.id'` no nível da coluna (num `ColumnDef`) não dispara o provisionamento; para isso, declare a referência no mapa `references` da tabela.

::: warning Atenção
Seeds fazem upsert de linhas e podem criar contas em `auth.users` com login funcional. A CLI se recusa a rodar seed num banco Supabase hospedado (`*.supabase.co`, `*.supabase.com`, `*.supabase.in`) sem `--allow-remote-seed` (`SEED_REMOTE_BLOCKED`). Nunca defina `ACCESSNEXUS_SEED_PASSWORD` para um banco acessível pela internet.
:::

## defineConfig

```ts
function defineConfig(options: DefineConfigOptions): ResolvedConfig;
```

Faça o default export dele no `accessnexus.config.ts` (ou `.js` / `.mjs`) na raiz do projeto. Todos os campos são opcionais. Caminhos relativos são resolvidos a partir do diretório de trabalho atual.

```ts
import { defineConfig } from 'accessnexus';

export default defineConfig({
  schema: './accessnexus.schema.ts',
  seed: './accessnexus.seed.ts',
  output: {
    dir: './generated',
    migrations: './supabase/migrations',
    sdk: './src/lib/accessnexus',
  },
  naming: { policyPrefix: 'app' },
  generate: { sqlOnly: false, sdkOnly: false },
  adapterOptions: {
    dbUrlEnv: 'SUPABASE_DB_URL',
    deterministic: true,
    uuidGeneration: 'v7',
  },
  targets: {
    staging: { adapter: 'supabase', adapterOptions: { dbUrlEnv: 'STAGING_DB_URL' } },
    prod: { adapter: 'supabase', adapterOptions: { dbUrlEnv: 'PROD_DB_URL' } },
  },
});
```

### DefineConfigOptions

| Campo | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `schema` | `string` | `'./accessnexus.schema.ts'` | Arquivo de schema. `--schema` sobrescreve. |
| `seed` | `string` | `'./accessnexus.seed.ts'` | Arquivo de seed para `seed` e `push --seed`. `seed --seed <path>` sobrescreve. |
| `output.dir` | `string` | `'./generated'` | Pasta base para os padrões abaixo. |
| `output.migrations` | `string` | `'{dir}/migrations'` | Arquivos SQL de migration e `.snapshot.json`. |
| `output.policies` | `string` | `'{dir}/policies'` | Arquivos `<table>_rls.sql`. |
| `output.triggers` | `string` | `'{dir}/triggers'` | Arquivos `<table>_triggers.sql`. |
| `output.rpcs` | `string` | `'{dir}/rpcs'` | `rpcs.sql`. |
| `output.sdk` | `string` | `'{dir}/sdk'` | `types.ts` e `client.ts`. |
| `adapter` | `string` | `'supabase'` | Só existe `'supabase'` (caso contrário, `ADAPTER_UNSUPPORTED`). |
| `adapterOptions` | `Record<string, unknown>` | `undefined` | Repassado ao adapter; veja abaixo. |
| `naming.policyPrefix` | `string` | `'accessnexus'` | Prefixo dos nomes de policies, helpers e triggers. `--prefix` sobrescreve. |
| `generate.sqlOnly` | `boolean` | `false` | Gera só SQL. Mesmo que `--sql-only`. |
| `generate.sdkOnly` | `boolean` | `false` | Gera só o SDK. Mesmo que `--sdk-only`. Passar as duas flags juntas dá `INVALID_FLAGS`. |
| `targets` | `Record<string, AccessNexusTarget>` | `undefined` | Bancos nomeados para `push` / `seed --target <name>`. |
| `adapters` | `Array<string \| AccessNexusTarget>` | `undefined` | Vários adapters para escolher com `--adapter <name>`. Normalmente omitido. |

`--output <dir>` coloca todas as categorias dentro de `<dir>` e ignora todos os caminhos de pasta `output.*` da config.

```ts
interface AccessNexusTarget {
  adapter: string;                         // 'supabase'
  adapterOptions?: Record<string, unknown>; // ex.: { dbUrlEnv: 'PROD_DB_URL' }
}
```

Um target sem `adapter` dá `TARGET_INVALID`; um nome desconhecido dá `TARGET_NOT_FOUND`. As `adapterOptions` de um target são usadas para encontrar a URL do banco e, no `seed`, são mescladas por cima das `adapterOptions` de nível superior.

### adapterOptions

Todas as chaves são opcionais. As que moldam o SQL são as [opções do SupabaseAdapter](/pt/api/adapter#options); a CLI também lê `dbUrlEnv`.

| Chave | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `dbUrlEnv` | `string` | `undefined` | Nome da variável de ambiente com a URL do Postgres para `push` / `seed`. Verificada depois de `--url` e antes das variáveis de ambiente embutidas. `datasource: { url: { env: '<NAME>' } }` é aceito como grafia alternativa. |
| `deterministic` | `boolean` | `false` | Omite a linha de cabeçalho `-- Generated at: <timestamp>` para que a saída seja estável byte a byte. |
| `uuidGeneration` | `'v4' \| 'v7'` | `'v4'` | `'v7'`: primary keys uuid usam `public.accessnexus_uuidv7()` como padrão (ordenado por tempo), e a migration define essa função. |
| `policyPrefix` | `string` | `'accessnexus'` | Igual a `naming.policyPrefix`, mas tem precedência sobre `naming.policyPrefix` e `--prefix`. Prefira `naming.policyPrefix`. |
| `schemaName` | `string` | `'public'` | Schema usado no `search_path` das funções e para qualificar tabelas dentro das funções geradas. |
| `idempotent` | `boolean` | `true` | Emite `DROP POLICY IF EXISTS` / `DROP TRIGGER IF EXISTS` antes de cada create. |
| `timestamps` | `boolean` | `true` | Emite o bloco de comentário de cabeçalho de cada arquivo SQL gerado. |
| `forceRLS` | `boolean` | `true` | Emite `FORCE ROW LEVEL SECURITY` depois do `ENABLE`. |
| `databaseTypes` | `string` | `'./database.types'` | Modo Database: caminho de import do seu arquivo `database.types`, relativo à pasta do SDK. |

::: warning Atenção
`forceRLS: false` deixa o dono da tabela passar por cima das policies. Mantenha o padrão.
:::

### ResolvedConfig

`defineConfig` retorna as opções com os padrões aplicados:

```ts
type ResolvedConfig = {
  schema: string;
  seed: string;
  adapter: string;
  output: { dir: string; migrations: string; policies: string; triggers: string; rpcs: string; sdk: string };
  adapterOptions?: Record<string, unknown>;
  targets?: Record<string, AccessNexusTarget>;
  adapters?: Array<string | AccessNexusTarget>;
  naming: { policyPrefix: string };
  generate: { sqlOnly: boolean; sdkOnly: boolean };
};
```

A busca do arquivo de config e a precedência das flags estão descritas na [referência da CLI](/pt/api/cli#config-resolution).

### AccessNexusConfig

`AccessNexusConfig` é uma interface exportada mais antiga, com os mesmos campos `schema`, `output`, `adapter`, `adapterOptions`, `naming` e `generate` (com `output` e `adapter` obrigatórios). A CLI não a usa; tipe os arquivos de config com `defineConfig`.
