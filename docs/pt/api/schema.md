# defineSchema / table

Declare as tabelas, colunas, regras de acesso, triggers e RPCs que o AccessNexus compila para SQL e para um SDK tipado. Guia: [Schema](/pt/guide/schema).

## defineSchema

```ts
// Modo manual: toda tabela declara `columns`
function defineSchema<T extends SchemaDef>(tables: T, options?: SchemaOptions): T;

// Modo Database: as colunas vêm de um tipo `Database` do Supabase
function defineSchema<DB extends SupabaseDatabase>(
  tables: SupabaseSchemaInput<DB>,
  options?: SchemaOptions,
): SchemaDef;

interface SchemaOptions {
  rpcs?: Record<string, RpcDef>;
}
```

| Parâmetro | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `tables` | `Record<string, TableDef>` ou `SupabaseSchemaInput<DB>` | obrigatório | Nome da tabela para a definição da tabela. Os nomes precisam ser snake_case minúsculo. |
| `options.rpcs` | `Record<string, RpcDef>` | `undefined` | Funções do Postgres criadas com [`rpc()`](/pt/api/rpc). Guardadas numa propriedade não enumerável `__rpcs`, então `Object.keys(schema)` lista só as tabelas. |

O arquivo de schema precisa fazer `export default` do resultado. A CLI carrega o arquivo com esbuild, então ele pode importar arquivos vizinhos.

### Detecção de modo {#mode-detection}

O modo é detectado em runtime, não pelo argumento genérico:

| Modo | Detectado quando | Gera |
| --- | --- | --- |
| Manual | pelo menos uma tabela declara `columns` | migrations DDL, RLS, triggers, RPCs, SDK (`types.ts` + `client.ts`) |
| Database | nenhuma tabela declara `columns` | RLS, triggers, RPCs, SDK (`client.ts` tipado a partir do seu `Database`). Sem migrations DDL. |

Misturar modos (algumas tabelas com `columns`, outras sem) é reportado pelo `validate` como `MISSING_COLUMNS`.

### Checagens feitas pelo defineSchema {#checks-performed-by-defineschema}

O `defineSchema` lança um `Error` cuja mensagem começa com `[AccessNexus]` (a CLI reporta como `SCHEMA_INVALID`) quando:

- um nome de tabela ou coluna não casa com `/^[a-z][a-z0-9_]*$/`;
- `primaryKey` não é uma coluna declarada (modo manual);
- uma chave de `references` não é uma coluna declarada (modo manual);
- uma referência não é `table.column` nem `schema.table.column`;
- uma referência de duas partes (`table.column`) aponta para uma tabela que não está no schema. Referências de três partes (`auth.users.id`) nunca são checadas.

Todo o resto (tipos de coluna, colunas das policies, palavras reservadas, opções de trigger) é checado pelo `accessnexus validate`; veja [Erros](/pt/api/errors#schema-issues).

### Modo manual {#manual-mode}

```ts
import { defineSchema, policy, rpc, table } from 'accessnexus';

export default defineSchema({
  todos: table({
    columns: {
      id: 'uuid',
      user_id: 'uuid',
      title: 'text',
      done: { type: 'boolean', default: 'false' },
    },
    primaryKey: 'id',
    references: { user_id: 'auth.users.id' },
    policies: {
      select: policy.isOwner('user_id'),
      insert: policy.isOwner('user_id'),
      update: policy.isOwner('user_id'),
      delete: policy.isOwner('user_id'),
    },
  }),
}, {
  rpcs: {
    count_open: rpc({
      returns: 'int',
      language: 'sql',
      body: 'SELECT count(*)::int FROM todos WHERE user_id = (SELECT auth.uid()) AND NOT done;',
    }),
  },
});
```

### Modo Database {#database-mode}

Passe o tipo `Database` gerado pelo Supabase como argumento genérico e omita `columns`. Nomes de tabela, `primaryKey`, chaves de `references` e `softDelete` têm autocomplete a partir do tipo. Liste só as tabelas que você configura.

```ts
import { defineSchema, policy, rpc } from 'accessnexus';
import type { Database } from './database.types.js';

export default defineSchema<Database>({
  profiles: {
    primaryKey: 'id',
    policies: {
      select: policy.isOwner('id'),
      update: policy.isOwner('id'),
    },
  },
}, {
  rpcs: { get_stats: rpc() },
});
```

Uma tabela no modo Database aceita `SupabaseTableDef`: `primaryKey`, `references`, `policies`, `triggers`, `enableRLS`, `indexes`, `softDelete`. Não há `columns` nem `onDelete` (nenhum DDL é gerado).

::: warning
No modo Database o `validate` não consegue checar nomes de coluna (ele não tem a lista de colunas). Um erro de digitação em `policy.isOwner('usr_id')` só é pego pelo Postgres na hora do `push`.
:::

## table

```ts
function table<TColumns extends Record<string, ColumnInput>>(def: TableDef<TColumns>): TableDef<TColumns>;
```

Retorna a definição com duas normalizações:

- `enableRLS` vira `true` quando `policies` está definido.
- Quando `softDelete` está definido e não há `trigger.softDelete`, um trigger de soft delete nessa coluna é adicionado a `triggers`.

## TableDef

```ts
interface TableDef<TColumns extends Record<string, ColumnInput>> {
  columns: TColumns;
  primaryKey?: keyof TColumns & string;
  references?: Partial<Record<keyof TColumns & string, string>>;
  onDelete?: Partial<Record<keyof TColumns & string, ForeignKeyAction>>;
  policies?: TablePolicies;
  triggers?: TableTriggers;
  enableRLS?: boolean;
  indexes?: IndexDef[];
  softDelete?: keyof TColumns & string;
}
```

| Opção | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `columns` | `Record<string, ColumnInput>` | obrigatório (modo manual) | Nome da coluna para uma string de tipo ou um [`ColumnDef`](#columndef). |
| `primaryKey` | nome de coluna | `undefined` | Primary key de coluna única. Sem ela o `validate` avisa `NO_PRIMARY_KEY`; o SDK, os upserts do seed e o soft delete passam a assumir `id`. |
| `references` | `{ [column]: 'table.column' \| 'schema.table.column' }` | `undefined` | Foreign keys. Equivale a `references` num `ColumnDef`; quando os dois estão definidos, vale o da coluna. |
| `onDelete` | `{ [column]: ForeignKeyAction }` | nenhuma ação | Ação de `ON DELETE` por coluna que referencia. Veja [Foreign keys](#foreign-keys). |
| `policies` | `TablePolicies` | `undefined` | Uma regra por operação: `{ select?, insert?, update?, delete? }`, cada uma criada com [`policy`](/pt/api/policy) ou [`definePermissions`](/pt/api/permissions). |
| `triggers` | `TriggerRule[]` | `[]` | Criados com [`trigger`](/pt/api/trigger). |
| `enableRLS` | `boolean` | `true` | Só `false` tem efeito: o RLS não é habilitado na tabela. |
| `indexes` | `IndexDef[]` | `[]` | Índices explícitos. Veja [IndexDef](#indexdef). |
| `softDelete` | nome de coluna | `undefined` | O DELETE vira `UPDATE ... SET <column> = NOW()`; o SDK filtra `<column> IS NULL`. A coluna deve ser `'timestamptz?'`. |

Chaves desconhecidas (por exemplo `polices`) são reportadas pelo `validate` como `UNKNOWN_TABLE_KEY`.

### Padrões de RLS {#rls-defaults}

Toda tabela recebe `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` e `FORCE ROW LEVEL SECURITY`.

| Definição da tabela | Resultado |
| --- | --- |
| `policies` definido | RLS ligado; operações sem regra são negadas. |
| sem `policies` | RLS ligado, sem policies: deny-all para `anon` e `authenticated` (só a service role). O `validate` avisa `NO_POLICIES`. |
| `enableRLS: false`, sem `policies` | Nenhum arquivo de RLS é gerado; a tabela fica aberta para a anon key. O `validate` avisa `RLS_DISABLED`. |
| `enableRLS: false` com `policies` | Erro do `validate` `RLS_DISABLED_WITH_POLICIES`. |

::: warning
`enableRLS: false` deixa a tabela legível e gravável por qualquer pessoa com a sua anon key pública. Use só numa tabela que deve mesmo ser aberta.
:::

## Tipos de coluna {#column-types}

Uma coluna é uma string de tipo ou um objeto [`ColumnDef`](#columndef). Acrescente `?` a qualquer tipo para torná-lo nullable; senão a coluna é `NOT NULL` (primary keys recebem `PRIMARY KEY` no lugar).

| Tipo | Postgres | Tipo TS gerado |
| --- | --- | --- |
| `'uuid'` | `UUID` | `string` |
| `'text'` | `TEXT` | `string` |
| `'varchar'` | `VARCHAR` | `string` |
| `'int'` | `INTEGER` | `number` |
| `'smallint'` | `SMALLINT` | `number` |
| `'bigint'` | `BIGINT` | `number` |
| `'serial'` | `SERIAL` | `number` |
| `'float'` | `DOUBLE PRECISION` | `number` |
| `'decimal'` | `NUMERIC` | `number` |
| `'boolean'` | `BOOLEAN` | `boolean` |
| `'json'` | `JSON` | `Record<string, unknown>` |
| `'jsonb'` | `JSONB` | `Record<string, unknown>` |
| `'date'` | `DATE` | `string` |
| `'timestamp'` | `TIMESTAMP` | `string` |
| `'timestamptz'` | `TIMESTAMPTZ` | `string` |
| `'time'` | `TIME` | `string` |
| `'text[]'` | `TEXT[]` | `string[]` |
| `'int[]'` | `INTEGER[]` | `number[]` |
| `'uuid[]'` | `UUID[]` | `string[]` |
| `"enum('a','b')"` | `<table>_<column>_enum` | `'a' \| 'b'` |
| qualquer um acima + `?` | o mesmo, nullable | `... \| null` |

Tipos exportados: `ScalarType` (os tipos acima), `NullableType` (`` `${ScalarType}?` ``), `ColumnType` (`ScalarType | NullableType`), `ColumnInput` (`ColumnType | ColumnDef`).

Tipos desconhecidos são reportados como `UNKNOWN_COLUMN_TYPE`, com sugestão para aliases comuns (`string` para `text`, `integer` para `int`, `bool` para `boolean`, `datetime` para `timestamptz`, `object` para `jsonb`, ...).

### Enums {#enums}

Escreva os valores dentro de `enum(...)`, entre aspas: `"enum('draft','published')"`. Cada coluna enum ganha seu próprio tipo no Postgres, chamado `<table>_<column>_enum`, criado com um bloco `DO $$ ... $$` idempotente. Duas colunas enum com os mesmos valores continuam sendo dois tipos distintos: faça cast via text (`v.role::text::org_members_role_enum`) ao compará-las em SQL.

### Padrões da primary key {#primary-key-defaults}

| Tipo da primary key | Sem `default` definido | Efeito |
| --- | --- | --- |
| `'uuid'` | `DEFAULT gen_random_uuid()` | `DEFAULT public.accessnexus_uuidv7()` quando `adapterOptions.uuidGeneration` é `'v7'` |
| `'bigint'` | `GENERATED ALWAYS AS IDENTITY` | |
| outro | nenhum | |

No tipo `<Table>Create` do SDK, uma primary key `uuid` ou `bigint` é opcional.

## ColumnDef

```ts
interface ColumnDef {
  type: ColumnType;
  default?: string;
  unique?: boolean;
  check?: string;
  references?: string;
  onDelete?: ForeignKeyAction;
}
```

| Campo | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `type` | `ColumnType` | obrigatório | Qualquer tipo da tabela acima. |
| `default` | `string` | `undefined` | SQL cru emitido depois de `DEFAULT`. Veja abaixo. |
| `unique` | `boolean` | `false` | Adiciona `UNIQUE`. |
| `check` | `string` | `undefined` | SQL cru emitido como `CHECK (<expr>)`, por exemplo `'amount >= 0'`. |
| `references` | `string` | `undefined` | Alvo da foreign key: `'table.column'` ou `'schema.table.column'` (por exemplo `'auth.users.id'`). |
| `onDelete` | `ForeignKeyAction` | nenhuma ação | Ação de `ON DELETE`. Exige `references`. |

`default` e `check` são emitidos literalmente. Funções e números não precisam de aspas (`'now()'`, `'gen_random_uuid()'`, `'0'`, `'false'`); um literal de string ou enum precisa das próprias aspas simples dentro da string JS: `default: "'todo'"`. Uma palavra solta como `default: 'todo'` seria lida pelo Postgres como nome de coluna; o `validate` reporta isso como `INVALID_DEFAULT`, e também rejeita um default de enum entre aspas que não seja um dos valores do enum.

```ts
import { defineSchema, policy, table } from 'accessnexus';

export default defineSchema({
  invoices: table({
    columns: {
      id: 'uuid',
      owner_id: { type: 'uuid', references: 'auth.users.id', onDelete: 'cascade' },
      number: { type: 'text', unique: true },
      amount: { type: 'decimal', check: 'amount >= 0' },
      status: { type: "enum('draft','sent','paid')", default: "'draft'" },
      created_at: { type: 'timestamptz', default: 'now()' },
      notes: 'text?',
    },
    primaryKey: 'id',
    policies: {
      select: policy.isOwner('owner_id'),
      insert: policy.isOwner('owner_id'),
      update: policy.isOwner('owner_id'),
      delete: policy.none(),
    },
  }),
});
```

## Foreign keys {#foreign-keys}

Uma referência é `'table.column'` (uma tabela deste schema) ou `'schema.table.column'` (uma tabela fora dele, como `'auth.users.id'`). Ela pode ser declarada na coluna (`ColumnDef.references`) ou no mapa `references` da tabela.

```ts
type ForeignKeyAction = 'cascade' | 'set null' | 'restrict' | 'no action';
```

| `onDelete` | Gerado | Efeito quando a linha pai é apagada |
| --- | --- | --- |
| omitido | `REFERENCES t(c)` | Igual a `'no action'`: o delete falha enquanto existirem filhos. |
| `'no action'` | `ON DELETE NO ACTION` | O delete falha enquanto existirem filhos (checado no fim do statement). |
| `'restrict'` | `ON DELETE RESTRICT` | O delete falha enquanto existirem filhos (checado na hora). |
| `'cascade'` | `ON DELETE CASCADE` | Os filhos são apagados. |
| `'set null'` | `ON DELETE SET NULL` | A coluna recebe `NULL`. A coluna precisa ser nullable. |

O `validate` reporta `INVALID_ON_DELETE` para uma ação desconhecida, um `onDelete` numa coluna sem foreign key ou `'set null'` numa coluna `NOT NULL`, e `CASCADE_INTO_SOFT_DELETE` para `'cascade'` numa tabela que usa soft delete.

::: warning
Cascades rodam como o dono da tabela: o RLS não os impede. Só use cascade quando apagar o pai deve apagar todos os filhos, seja quem for o dono deles.
:::

As tabelas são emitidas em ordem de dependência (tabelas referenciadas primeiro). Toda coluna de foreign key ganha um índice (veja abaixo).

## IndexDef

```ts
interface IndexDef {
  columns: string[];
  unique?: boolean;
  name?: string;
}
```

| Campo | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `columns` | `string[]` | obrigatório | Colunas indexadas, em ordem. |
| `unique` | `boolean` | `false` | `CREATE UNIQUE INDEX`. |
| `name` | `string` | `idx_<table>_<col1>_<col2>_<n>` | `n` é a posição (a partir de 1) em `indexes`. |

`IndexDef` não é exportado de `accessnexus`; escreva os objetos inline.

O AccessNexus também cria estes índices automaticamente (`CREATE INDEX IF NOT EXISTS`):

| Índice | Colunas | Pulado quando |
| --- | --- | --- |
| `idx_<table>_<col>_fk` | cada coluna de foreign key | a coluna é a primary key, é `unique` ou já está coberta por um índice explícito não único de coluna única |
| `idx_<table>_<col>_rls` | cada coluna usada por `policy.isOwner`, `policy.belongsTo` ou por um lado de coluna de `policy.matchesField` | a coluna é a primary key ou já foi indexada acima |
| `idx_<table>_active_pk` | `(<primaryKey>) WHERE <softDelete> IS NULL` | a tabela não tem `softDelete` ou não tem `primaryKey` |

## Identificadores {#identifiers}

Os identificadores são emitidos sem aspas, então nomes de tabela, coluna, RPC e trigger precisam ser snake_case minúsculo (`INVALID_IDENTIFIER`) e não podem ser palavras reservadas do Postgres como `order`, `user`, `group`, `limit`, `select` (`RESERVED_IDENTIFIER`).

## Tipos relacionados {#related-types}

| Tipo | Descrição |
| --- | --- |
| `SchemaDef` | `Record<string, TableDef>` |
| `TableDef<TColumns>` | Tabela do modo manual, acima. |
| `SupabaseTableDef<TRow>` | Tabela do modo Database (sem `columns`, sem `onDelete`). |
| `SupabaseSchemaInput<DB>` | `{ [table in TableNamesOf<DB>]?: SupabaseTableDef<RowOf<DB, table>> }` |
| `SupabaseDatabase` | Restrição que aceita qualquer tipo `Database` gerado pelo Supabase. |
| `TablesOf<DB>`, `TableNamesOf<DB>`, `RowOf<DB, T>`, `InsertOf<DB, T>`, `UpdateOf<DB, T>`, `FunctionsOf<DB>`, `FunctionNamesOf<DB>`, `PublicSchema<DB>` | Helpers sobre o schema `public` de um tipo `Database`. |
| `GenericTable`, `GenericSchema` | Formatos estruturais de uma tabela e de um schema do Supabase. |
| `TablePolicies` | `{ select?: PolicyRule; insert?: PolicyRule; update?: PolicyRule; delete?: PolicyRule }` |
| `TableTriggers` | `TriggerRule[]` |
