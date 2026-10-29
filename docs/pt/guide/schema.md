# Schema

`accessnexus.schema.ts` é a única fonte da verdade do seu banco. Ele exporta por padrão `defineSchema({...})`, um mapa de nomes de tabela para definições de tabela. Esta página cobre o formato de tabelas e colunas; as regras de acesso estão em [Policies](/pt/guide/policies) e [Permissões](/pt/guide/permissions).

Há duas formas de definir um schema:

- **Modo manual**: toda tabela declara suas `columns` com `table({...})`. O AccessNexus também gera as migrations DDL.
- **Modo Database**: as colunas vêm do tipo `Database` que o Supabase gera. O AccessNexus gera RLS, triggers, RPCs e o SDK, mas não migrations.

O modo é detectado automaticamente: modo Database quando nenhuma tabela declara `columns`.

## Uma tabela no modo manual {#a-manual-mode-table}

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table, trigger } from 'accessnexus';

export default defineSchema({
  posts: table({
    columns: {
      id: 'uuid',
      author_id: 'uuid',
      title: 'text',
      status: { type: "enum('draft','published')", default: "'draft'" },
      tags: 'text[]?',
      created_at: { type: 'timestamptz', default: 'now()' },
      updated_at: 'timestamptz?',
      deleted_at: 'timestamptz?',
    },
    primaryKey: 'id',
    references: { author_id: 'auth.users.id' },
    indexes: [{ columns: ['author_id', 'status'] }],
    softDelete: 'deleted_at',
    triggers: [trigger.updatedAt('updated_at')],
    policies: {
      select: policy.isOwner('author_id'),
      insert: policy.isOwner('author_id'),
      update: policy.isOwner('author_id'),
      delete: policy.isOwner('author_id'),
    },
  }),
});
```

Nomes de tabela e coluna devem estar em `snake_case` minúsculo e não podem ser palavras reservadas do SQL: `order`, `user`, `group`, `limit` são rejeitados (`RESERVED_IDENTIFIER`); use `orders`, `user_id`. Os identificadores são emitidos sem aspas, por isso a regra é rígida.

## Opções da tabela {#table-options}

| Opção | Tipo | Descrição |
| --- | --- | --- |
| `columns` | `Record<string, ColumnInput>` | Obrigatório no modo manual. Veja [Colunas](#columns) |
| `primaryKey` | nome de coluna | A coluna da chave primária |
| `compositePrimaryKey` | nomes de coluna | Uma chave sobre várias colunas, no lugar de `primaryKey` |
| `references` | `{ column: 'table.column' }` | Chaves estrangeiras. Use `'schema.table.column'` para outros schemas, por exemplo `'auth.users.id'` |
| `onDelete` | `{ column: action }` | `ON DELETE` por coluna que referencia: `'cascade'`, `'set null'`, `'restrict'`, `'no action'` |
| `indexes` | `{ columns, unique?, name? }[]` | Índices extras |
| `softDelete` | nome de coluna | O DELETE preenche esta coluna com `NOW()` em vez de remover a linha |
| `policies` | `{ select?, insert?, update?, delete? }` | Uma regra por operação. Veja [Policies](/pt/guide/policies) |
| `triggers` | `TriggerRule[]` | Veja [Triggers](/pt/guide/triggers) |
| `enableRLS` | `boolean` | Só `false` importa: ele desliga o RLS. Veja [RLS está sempre ligado](#rls-is-always-on) |

## Colunas {#columns}

Uma coluna é uma string de tipo, ou um objeto quando precisa de mais do que o tipo:

```ts
columns: {
  name: 'text',                                          // NOT NULL
  bio: 'text?',                                          // anulável
  score: { type: 'int', default: '0', check: 'score >= 0' },
  slug: { type: 'text', unique: true },
}
```

### Tipos {#types}

| Tipo | Tipo TypeScript no SDK |
| --- | --- |
| `uuid`, `text`, `varchar` | `string` |
| `date`, `timestamp`, `timestamptz`, `time` | `string` |
| `int`, `smallint`, `bigint`, `serial`, `float`, `decimal`, `numeric`, `numeric(p,s)` | `number` |
| `boolean` | `boolean` |
| `json`, `jsonb` | `Record<string, unknown>` |
| `text[]`, `uuid[]` | `string[]` |
| `int[]` | `number[]` |
| `"enum('a','b')"` | `string` |

Acrescente `?` a qualquer tipo para torná-lo anulável: `'text?'`, `'uuid[]?'`, `"enum('a','b')?"`. Sem `?`, a coluna é `NOT NULL`.

### Objeto de coluna {#column-object}

| Campo | Descrição |
| --- | --- |
| `type` | Qualquer tipo acima, com ou sem `?` |
| `default` | Expressão SQL de default crua, emitida literalmente |
| `unique` | Adiciona uma constraint `UNIQUE` |
| `check` | Expressão SQL `CHECK` crua, por exemplo `'amount >= 0'` |
| `references` | Alvo da chave estrangeira, no mesmo formato do `references` da tabela |
| `onDelete` | Ação `ON DELETE` da chave estrangeira desta coluna |

### Defaults são SQL cru {#defaults-are-raw-sql}

`default` e `check` são copiados para o SQL do jeito que foram escritos. Funções, números e booleanos funcionam como strings simples: `'now()'`, `'0'`, `'false'`. Um **literal de string ou de enum precisa das próprias aspas simples** dentro da string JavaScript:

```ts
status: { type: "enum('todo','done')", default: "'todo'" }  // DEFAULT 'todo'
```

::: warning
`default: 'todo'` emitiria `DEFAULT todo`, que o Postgres lê como nome de coluna. O `validate` reporta isso como `INVALID_DEFAULT`.
:::

### Enums {#enums}

`"enum('todo','doing','done')"` cria um tipo dedicado no Postgres chamado `<table>_<column>_enum`:

```sql
CREATE TYPE tasks_status_enum AS ENUM ('todo', 'doing', 'done');
```

Cada coluna enum ganha o próprio tipo, mesmo quando duas colunas listam os mesmos valores. Para compará-las em SQL, faça o cast via text: `v.role::text::org_members_role_enum`.

### Chaves primárias {#primary-keys}

| Tipo da chave primária | Gerado |
| --- | --- |
| `uuid` | `DEFAULT gen_random_uuid()` |
| `bigint` | `GENERATED ALWAYS AS IDENTITY` |

Para UUIDs ordenados por tempo, defina `adapterOptions.uuidGeneration: 'v7'` em `accessnexus.config.ts`: as chaves primárias uuid passam a usar como default um helper gerado `accessnexus_uuidv7()`. Uma tabela sem `primaryKey` dispara o warning `NO_PRIMARY_KEY`; `findById`, `update` e `delete` do SDK funcionam pela chave primária.

## References e `onDelete` {#references-and-ondelete}

Declare chaves estrangeiras no nível da tabela ou na coluna:

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table } from 'accessnexus';

const ownerOnly = {
  select: policy.isOwner('owner_id'),
  insert: policy.isOwner('owner_id'),
  update: policy.isOwner('owner_id'),
  delete: policy.isOwner('owner_id'),
};

export default defineSchema({
  projects: table({
    columns: { id: 'uuid', owner_id: 'uuid', name: 'text' },
    primaryKey: 'id',
    references: { owner_id: 'auth.users.id' },
    policies: ownerOnly,
  }),
  tasks: table({
    columns: {
      id: 'uuid',
      owner_id: 'uuid',
      // forma na coluna: as tasks vão junto com o projeto
      project_id: { type: 'uuid', references: 'projects.id', onDelete: 'cascade' },
      assignee_id: 'uuid?',
    },
    primaryKey: 'id',
    references: { owner_id: 'auth.users.id', assignee_id: 'auth.users.id' },
    onDelete: { assignee_id: 'set null' }, // forma na tabela
    policies: ownerOnly,
  }),
});
```

| Ação | Ao apagar uma linha pai que tem filhos |
| --- | --- |
| *(padrão)* `'no action'` | Falha com erro de chave estrangeira |
| `'restrict'` | Falha com erro de chave estrangeira |
| `'cascade'` | Apaga os filhos também |
| `'set null'` | Define a coluna do filho como `NULL` (a coluna precisa ser anulável) |

Colunas de chave estrangeira ganham um índice automaticamente (`idx_<table>_<column>_fk`), a menos que você declare um índice de coluna única nelas. `references` também alimenta a opção `include` do SDK, que embute linhas relacionadas.

::: warning Cascades ignoram o RLS
Um cascade roda como dono da tabela: o RLS da tabela filha não o impede. Só use cascade quando apagar o pai realmente deve apagar tudo abaixo dele. `'cascade'` para uma tabela com `softDelete` é rejeitado (`CASCADE_INTO_SOFT_DELETE`), porque o soft delete deixaria filhos apontando para um pai apagado: use `'restrict'` e faça o soft delete dos filhos antes.
:::

## Índices {#indexes}

```ts
indexes: [
  { columns: ['project_id', 'status'] },
  { columns: ['project_id', 'title'], unique: true, name: 'tasks_project_title_key' },
]
```

Sem `name`, o AccessNexus nomeia o índice a partir da tabela e das colunas, por exemplo `idx_tasks_project_id_status_1`. As colunas são verificadas pelo `validate` (`UNKNOWN_COLUMN`).

## Soft delete {#soft-delete}

`softDelete: 'deleted_at'` transforma um DELETE em `UPDATE ... SET deleted_at = NOW()`. Ele adiciona:

- um trigger `BEFORE DELETE` que preenche a coluna e cancela o delete;
- um trigger de guarda que rejeita qualquer UPDATE comum de um usuário da API que preencha ou limpe a coluna, de modo que só o DELETE (e sua policy) pode fazer soft delete de uma linha;
- um índice parcial na chave primária `WHERE deleted_at IS NULL`;
- um filtro automático `deleted_at IS NULL` nas leituras do SDK.

Use uma coluna timestamp anulável (`'timestamptz?'`): `NULL` significa ativa, um timestamp significa apagada. A policy de DELETE decide quem pode fazer soft delete; restaure linhas com a service role ou uma RPC `security: 'definer'`.

::: danger Linhas com soft delete continuam visíveis pelo RLS
Só o SDK as filtra. Uma query crua pela API (`supabase.from('posts').select()`) ainda as retorna. Para escondê-las de todo cliente, coloque a condição na regra de `select`, por exemplo `policy.all([policy.isOwner('author_id'), policy.custom('deleted_at IS NULL')])`.
:::

Os detalhes dos triggers gerados estão em [Triggers](/pt/guide/triggers#soft-delete).

## RLS está sempre ligado {#rls-is-always-on}

Toda tabela recebe `ENABLE` e `FORCE ROW LEVEL SECURITY`.

| Definição da tabela | Resultado pela API |
| --- | --- |
| `policies` com uma regra por operação | Cada operação segue sua regra |
| `policies` sem alguma operação | Essa operação é negada |
| Nenhuma `policies` | Nega tudo para `anon` e `authenticated`; só a service role e código `SECURITY DEFINER` chegam nela. O `validate` avisa `NO_POLICIES` |
| `enableRLS: false` | RLS desligado: qualquer um com a anon key pode ler e escrever. O `validate` avisa `RLS_DISABLED` |

Uma tabela sem policies é a escolha certa para dados só do servidor. Para uma tabela que o cliente usa, adicione policies e bloqueie operações individuais com `policy.none()`.

::: danger Nunca use `enableRLS: false` para corrigir um erro de permissão
Isso abre a tabela inteira para qualquer um que tenha sua anon key pública. Use apenas numa tabela que deve ser totalmente aberta, e só quando alguém pediu isso.
:::

## Modo Database {#database-mode}

Se o seu projeto já tem um `database.types.ts` gerado pelo Supabase (`supabase gen types typescript`), você pode pular a redeclaração das colunas. Passe o tipo `Database` para o `defineSchema` e liste só as tabelas que quer configurar, sem `columns`:

```ts [accessnexus.schema.ts]
import { defineSchema, policy, rpc } from 'accessnexus';
import type { Database } from './database.types.js';

export default defineSchema<Database>({
  profiles: {
    primaryKey: 'id',
    policies: {
      // Cada usuário lê só o próprio perfil
      select: policy.isOwner('id'),
      update: policy.isOwner('id'),
    },
  },
}, {
  rpcs: { get_stats: rpc() },
});
```

Uma tabela no modo Database aceita `primaryKey`, `references`, `policies`, `triggers`, `enableRLS`, `indexes` e `softDelete`. O TypeScript autocompleta os nomes de coluna em `primaryKey`, `references` e `softDelete` a partir do tipo `Row`. `rpc()` sem corpo marca uma função existente para que o SDK a tipe.

O que muda em relação ao modo manual:

| | Modo manual | Modo Database |
| --- | --- | --- |
| Colunas | Declaradas no schema | Vêm do tipo `Database` |
| Migrations (DDL) | Geradas | Não geradas: as tabelas já existem |
| RLS, triggers, RPCs | Gerados | Gerados |
| SDK | `types.ts` + `client.ts` | `client.ts`, tipado pelo seu tipo `Database` |
| Checagem de colunas no `validate` | Nomes de coluna em policies, triggers e índices são verificados | As colunas não são conhecidas em runtime, então nomes dentro de `policy.*` não são verificados |

No modo Database, o `client.ts` gerado importa `Database` de `./database.types`, relativo à pasta de saída do SDK. Se o seu arquivo de tipos fica em outro lugar, aponte `adapterOptions.databaseTypes` para ele (o caminho é relativo à pasta do SDK):

```ts [accessnexus.config.ts]
import { defineConfig } from 'accessnexus';

export default defineConfig({
  adapterOptions: {
    databaseTypes: '../../database.types.js', // de generated/sdk/ para ./database.types.ts
  },
});
```

::: warning Confira as colunas das policies você mesmo no modo Database
Numa execução de teste, `policy.isOwner('idx')` numa tabela sem coluna `idx` passou no `validate` em modo Database. Revise o `<table>_rls.sql` gerado antes de dar push.
:::

### Qual modo usar {#which-mode-to-use}

- **Projeto novo, ou você quer que o AccessNexus seja dono das tabelas:** modo manual. Você ganha migrations, checagens estáticas completas e tipos do SDK a partir de um único arquivo.
- **Projeto existente cujas tabelas são gerenciadas em outro lugar** (Supabase Studio, outra ferramenta de migration), e você só quer RLS, triggers e um client tipado: modo Database.
- **Projeto existente que você quer migrar por completo para o AccessNexus:** rode `init --db-url` para importar tabelas, colunas, chaves, policies de RLS e funções para um schema em modo manual. Veja [Adotando um projeto existente](/pt/guide/existing-project).

## Dividindo o schema {#splitting-the-schema}

O arquivo de schema pode importar arquivos vizinhos; ele é empacotado com esbuild. Escreva imports relativos com extensão `.js` (`'./db/columns.js'` resolve para `db/columns.ts`), o que funciona com qualquer `moduleResolution` do TypeScript.

## Próximos passos {#next-steps}

- [Policies](/pt/guide/policies) - quem pode ler e escrever em cada tabela
- [Triggers](/pt/guide/triggers) - `updatedAt`, soft delete, audit log e travas de coluna
- [API de schema](/pt/api/schema) - referência completa de tipos de `defineSchema`, `table` e colunas
- [Configuração](/pt/api/seed-config) - opções do `defineConfig`, como `uuidGeneration`
