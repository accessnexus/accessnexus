# SupabaseAdapter

Compila um schema para SQL do Supabase/Postgres e para o SDK tipado. A CLI usa o adapter por você; use-o diretamente em testes ou em ferramentas próprias. Todo método é puro: devolve os arquivos como `{ path, content }` e não grava nada.

```ts
import { SupabaseAdapter } from 'accessnexus';
// também: import { SupabaseAdapter } from 'accessnexus/adapters/supabase';
```

## Construtor {#constructor}

```ts
new SupabaseAdapter(options?: SupabaseAdapterOptions)
```

### Opções {#options}

| Opção | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `policyPrefix` | `string` | `'accessnexus'` | Prefixo dos nomes de policies (`<prefix>_<table>_<op>`), helpers de membership, funções de trigger e triggers. |
| `schemaName` | `string` | `'public'` | Usado em `SET search_path = pg_catalog, <schemaName>` e para qualificar as tabelas dentro das funções geradas. O DDL das tabelas e as policies usam nomes não qualificados. |
| `idempotent` | `boolean` | `true` | Emite `DROP POLICY IF EXISTS` / `DROP TRIGGER IF EXISTS` antes de cada create. |
| `timestamps` | `boolean` | `true` | Emite o bloco de comentário de cabeçalho de cada arquivo SQL. |
| `forceRLS` | `boolean` | `true` | Emite `FORCE ROW LEVEL SECURITY` depois de `ENABLE ROW LEVEL SECURITY`. |
| `uuidGeneration` | `'v4' \| 'v7'` | `'v4'` | Padrão para primary keys `uuid` sem `default`: `gen_random_uuid()` ou `public.accessnexus_uuidv7()`. Com `'v7'`, a migration também define `public.accessnexus_uuidv7()` (UUIDv7 da RFC 9562; EXECUTE revogado de `PUBLIC` e `anon`, concedido a `authenticated` e `service_role`, e a `anon` só quando uma tabela v7 aceita inserts anônimos). |
| `databaseTypes` | `string` | `'./database.types'` | Só no Database mode: caminho de import do arquivo `database.types` do Supabase, relativo à pasta de saída do SDK. |
| `deterministic` | `boolean` | `false` | Omite a linha de cabeçalho `-- Generated at: <timestamp>`. |

::: warning
`forceRLS: false` deixa o dono da tabela ignorar todas as policies. Mantenha o padrão.
:::

No `accessnexus.config.ts`, essas opções ficam em `adapterOptions`; veja [defineConfig](/pt/api/seed-config#adapteroptions).

## Métodos {#methods}

| Método | Retorno | Arquivos |
| --- | --- | --- |
| `generatePolicies(schema)` | `GeneratedOutput[]` | `<table>_rls.sql` por tabela, exceto tabelas com `enableRLS: false` e sem `policies` |
| `generateTriggers(schema)` | `GeneratedOutput[]` | `<table>_triggers.sql` por tabela com pelo menos um trigger |
| `generateMigrations(schema)` | `GeneratedOutput[]` | `001_initial.sql` com o DDL completo; `[]` no Database mode ou para um schema vazio |
| `generateRpcs(schema)` | `GeneratedOutput[]` | `rpcs.sql` quando pelo menos uma RPC tem `body`; senão `[]` |
| `generateClient(schema)` | `GeneratedOutput[]` | modo manual: `types.ts`, `client.ts`; Database mode: `client.ts` |
| `generateSeed(schema, data, options?)` | `GeneratedOutput[]` | `seed.sql` (sempre um arquivo) |
| `ruleToSQL(rule)` | `string` | expressão `USING` de uma regra de policy |
| `ruleToCheckSQL(rule)` | `string` | expressão `WITH CHECK` de uma regra de policy |
| `triggerRuleToSQL(rule, tableName, tableDef)` | `string` | SQL da função e do `CREATE TRIGGER` de uma regra de trigger |
| `name` | `'supabase'` | identificador do adapter (propriedade) |

```ts
interface GeneratedOutput {
  path: string;        // nome de arquivo relativo, ex.: 'profiles_rls.sql'
  content: string;
  overwrite?: boolean; // não é definido pelo SupabaseAdapter
}
```

### generatePolicies

RLS de cada tabela: `ENABLE` e `FORCE ROW LEVEL SECURITY`, funções helper de membership para regras `belongsTo` (com seus `REVOKE` / `GRANT`) e, em seguida, um `CREATE POLICY` por operação. Uma tabela sem `policies` recebe só as linhas `ALTER TABLE` e um comentário `-- No policies: deny-all ...`. Veja [policy](/pt/api/policy#how-a-rule-becomes-a-policy).

### generateMigrations

DDL completo do zero: tipos enum, a função opcional `public.accessnexus_uuidv7()`, `CREATE TABLE IF NOT EXISTS` em ordem de dependência e, por fim, os índices explícitos e automáticos.

A CLI não grava esse arquivo como está: o `generate` salva `<timestamp>__init.sql` na primeira execução e migrations incrementais `<timestamp>__changes.sql` depois, rastreadas pelo `.snapshot.json`. Esse versionamento não faz parte da API do adapter.

### generateClient

O SDK tipado. Veja [SDK](/pt/api/sdk).

### generateSeed

```ts
generateSeed(schema: SchemaDef, data: SeedDef, options?: SeedSqlOptions): GeneratedOutput[];

interface SeedSqlOptions {
  authPassword?: string; // senha das linhas provisionadas em auth.users; aleatória se omitida
}
```

Faz upserts em ordem de dependência e provisiona linhas em `auth.users`. Veja [defineSeed](/pt/api/seed-config#generated-seed-sql).

### ruleToSQL / ruleToCheckSQL

Compiladores de baixo nível para uma única regra. Chamada fora do `generatePolicies`, uma regra `belongsTo` é renderizada como subquery inline (`org_id IN (SELECT org_id FROM org_members WHERE user_id = (SELECT auth.uid()))`) em vez do helper `SECURITY DEFINER` usado nas policies geradas.

### triggerRuleToSQL

Compila uma regra de trigger para `tableName`. `tableDef` fornece a primary key (soft delete) e as colunas `updatedAt` que o `lockColumns` deve ignorar.

## Exemplo {#example}

```ts
import { SupabaseAdapter } from 'accessnexus';
import schema from './accessnexus.schema.js';

const adapter = new SupabaseAdapter({ policyPrefix: 'app', deterministic: true });

const files = [
  ...adapter.generateMigrations(schema),
  ...adapter.generatePolicies(schema),
  ...adapter.generateTriggers(schema),
  ...adapter.generateRpcs(schema),
  ...adapter.generateClient(schema),
];

for (const file of files) {
  console.log(file.path, file.content.length);
}
```

Snapshot test das policies de uma tabela:

```ts
import { SupabaseAdapter, defineSchema, policy, table } from 'accessnexus';

const schema = defineSchema({
  notes: table({
    columns: { id: 'uuid', owner_id: 'uuid', body: 'text' },
    primaryKey: 'id',
    policies: { select: policy.isOwner('owner_id'), insert: policy.isOwner('owner_id') },
  }),
});

const [rls] = new SupabaseAdapter({ deterministic: true }).generatePolicies(schema);
export const sql: string = rls.content; // CREATE POLICY "accessnexus_notes_select" ...
```

## Interface Adapter {#adapter-interface}

O `SupabaseAdapter` implementa a interface exportada `Adapter`:

```ts
interface Adapter {
  readonly name: string;
  generatePolicies(schema: SchemaDef): GeneratedOutput[];
  generateClient(schema: SchemaDef): GeneratedOutput[];
  generateMigrations?(schema: SchemaDef): GeneratedOutput[];
  generateTriggers?(schema: SchemaDef): GeneratedOutput[];
  generateRpcs?(schema: SchemaDef): GeneratedOutput[];
  generateSeed?(schema: SchemaDef, data: SeedDef, options?: SeedSqlOptions): GeneratedOutput[];
}
```

A CLI só executa o adapter `supabase`.
