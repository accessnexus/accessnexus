# Como funciona {#how-it-works}

O AccessNexus é um compilador: ele lê um schema TypeScript, faz as checagens e escreve arquivos SQL e TypeScript. Só o `push` fala com o banco. Esta página acompanha um schema ao longo desse pipeline.

## O pipeline {#the-pipeline}

```
accessnexus.schema.ts  (+ accessnexus.config.ts, accessnexus.seed.ts)
        │
        │  bundled with esbuild and evaluated
        ▼
  schema object  ──►  validate  (static checks: columns, policies, triggers, security warnings)
        │
        │  generate (Supabase adapter)
        ▼
  generated/migrations/  <timestamp>__init.sql, <timestamp>__changes.sql, .snapshot.json
  generated/policies/    <table>_rls.sql
  generated/triggers/    <table>_triggers.sql
  generated/rpcs/        rpcs.sql
  <sdk dir>/             types.ts, client.ts
        │
        │  push: migrations → policies → triggers → rpcs
        ▼
  Postgres  (applied files tracked in public.accessnexus_migrations)
```

1. **Carregamento.** Os arquivos de schema, config e seed são empacotados com o esbuild e avaliados. Eles podem importar arquivos vizinhos; sintaxe exclusiva de TypeScript funciona no Node 20+.
2. **Validação.** Os builders rejeitam definições malformadas (identificadores inválidos, papéis desconhecidos) quando o arquivo roda. Depois o `validate` faz as checagens estáticas que o TypeScript não consegue: colunas desconhecidas nas policies, defaults com palavra solta, escritas abertas, personificação de linha de usuário e mais. `generate`, `diff` e `push` rodam as mesmas checagens antes.
3. **Geração.** O adapter do Supabase compila cada parte em SQL e no SDK. Os geradores são funções puras que retornam `{ path, content }`; a CLI grava isso em disco. O mesmo adapter está disponível programaticamente como `SupabaseAdapter` (veja [API do adapter](/pt/api/adapter)).
4. **Push.** Os arquivos gerados são aplicados em ordem, cada um na sua própria transação, e registrados numa tabela de controle.

## Pastas geradas {#generated-folders}

| Pasta | Conteúdo | Muda quando |
| --- | --- | --- |
| `migrations/` | DDL: `CREATE TABLE`, `ALTER TABLE`, índices, tipos enum, mais o `.snapshot.json` | Colunas, chaves, referências, índices ou enums mudam |
| `policies/` | Um `<table>_rls.sql` por tabela: `ENABLE` / `FORCE ROW LEVEL SECURITY`, helpers de membership, `DROP POLICY IF EXISTS` + `CREATE POLICY` | Policies ou permissões mudam |
| `triggers/` | Um `<table>_triggers.sql` por tabela com triggers: `CREATE OR REPLACE FUNCTION` + `CREATE TRIGGER` | Triggers ou soft delete mudam |
| `rpcs/` | `rpcs.sql` com toda RPC que tem `body` | RPCs mudam |
| `sdk/` | `types.ts` (tipos de linha, create, update e um tipo `Database`) e `client.ts` (`createAccessNexusClient`) | Qualquer coisa que mude o formato das tabelas ou RPCs |

Todas as pastas têm `./generated/<category>` como padrão e podem ser movidas individualmente no `accessnexus.config.ts` (`output.migrations`, `output.sdk`, ...). `--output <dir>` coloca todas as pastas num único diretório, o que é útil para pré-visualizar numa pasta de rascunho.

Os arquivos de policy, trigger e RPC são **reescritos por inteiro** a cada `generate` e podem ser reaplicados com segurança: eles removem e recriam as próprias policies e substituem as próprias funções. As migrations são **append-only**.

::: tip Modo Database
Quando o schema pega as colunas de um tipo `Database` do Supabase, nenhuma migration é gerada: as tabelas já existem. Policies, triggers, RPCs e o SDK são gerados normalmente. Veja [Schema](/pt/guide/schema#database-mode).
:::

## Migrations e snapshots {#migrations-and-snapshots}

O primeiro `generate` escreve `<timestamp>__init.sql` com o DDL completo e um `.snapshot.json` ao lado. O snapshot guarda o estado do schema que aquela migration produziu (resumido aqui):

```json [generated/migrations/.snapshot.json]
{
  "version": 3,
  "definitionHash": "1fdc1374",
  "schemaHash": "3ec55f9f",
  "schemaState": {
    "tables": {
      "notes": {
        "primaryKey": "id",
        "columns": { "...": "..." },
        "indexes": [ "..." ]
      }
    }
  },
  "lastMigrationFile": "20261029213510__init.sql"
}
```

No `generate` seguinte, o AccessNexus calcula o hash do estado atual do schema e compara com `schemaHash`:

- **Mesmo hash:** nenhuma migration nova. Mudar só policies ou triggers nunca cria um arquivo de migration.
- **Hash diferente:** ele compara o `schemaState` antigo com o novo e escreve `<timestamp>__changes.sql` só com o DDL incremental, depois atualiza o snapshot.

Adicionar uma coluna `pinned` à tabela `notes` do início rápido produziu:

```sql [generated/migrations/20261029213549__changes.sql]
-- ============================================
-- AccessNexus: Incremental schema changes
-- ============================================

ALTER TABLE notes ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false;
```

Renomeações são detectadas por heurística. Um statement que remove uma tabela ou coluna, ou muda o tipo de uma coluna, é marcado com um comentário `-- Destructive:` e reportado no campo `destructive` de `generate --json` e `diff --json`. Se a intenção era renomear, faça uma renomeação no schema em vez de remover + adicionar.

::: warning Commite o snapshot
O `.snapshot.json` é o que permite calcular a próxima migration. Commite-o junto com as migrations; apagá-lo faz o próximo `generate` recomeçar com um novo arquivo `__init`.
:::

## O que o push faz {#what-push-does}

O `push` executa estes passos, nesta ordem:

| Passo | Em caso de falha |
| --- | --- |
| Coleta os arquivos SQL gerados | `NOTHING_TO_PUSH`: rode `generate` |
| Resolve a URL do banco (`--url`, `adapterOptions.dbUrlEnv`, `ACCESSNEXUS_DB_URL`, `SUPABASE_DB_URL`, `DATABASE_URL`) e carrega o driver `pg` | `DB_URL_MISSING`, `PG_DRIVER_MISSING` |
| Carrega e valida o schema, e confere se o SQL gerado bate com ele | `SCHEMA_VALIDATION_FAILED`, `GENERATED_OUT_OF_DATE`: rode `generate` |
| Conecta (timeout de 10 s; `ACCESSNEXUS_DB_CONNECT_TIMEOUT` para mudar) | `DB_CONNECTION_FAILED` |
| Confere se o papel ignora o RLS quando o SQL tem helpers `SECURITY DEFINER` | `PUSH_ROLE_NO_BYPASSRLS` |
| Pega o lock do push | Espera, e imprime um aviso em vez de travar em silêncio |
| Abre uma única transação; recusa policies de RLS em tabelas gerenciadas que o AccessNexus não gerou, a menos que haja `--replace-foreign-policies` (aí as remove) | `FOREIGN_POLICIES` |
| Recusa migrations pendentes que destroem dados, a menos que haja `--allow-destructive` | `DESTRUCTIVE_MIGRATION` |
| Aplica os arquivos: migrations → policies → triggers → rpcs, e faz o commit | `PUSH_FAILED` (o push inteiro sofre rollback) |

Nada é aplicado se qualquer checagem antes do último passo falhar. O `push --dry-run` para depois da checagem do schema: ele lista o plano e eventuais statements destrutivos sem conectar.

### A tabela de controle {#the-tracking-table}

Todo arquivo aplicado é registrado em `public.accessnexus_migrations`:

| Coluna | Significado |
| --- | --- |
| `filename` | Caminho do arquivo, ex.: `generated/policies/notes_rls.sql` |
| `category` | `migrations`, `policies`, `triggers` ou `rpcs` |
| `checksum` | SHA-256 do conteúdo do arquivo, normalizado (veja abaixo) |
| `hash_strategy` | Como o checksum foi calculado (`normalized_sql_v1`) |
| `applied_at`, `execution_time_ms` | Quando e quanto tempo levou |
| `success`, `logs` | Um arquivo que falhou é registrado com `success = false` e o erro do Postgres |

### Hash do conteúdo {#content-hashing}

Antes de calcular o hash, o AccessNexus remove a linha de cabeçalho `-- Generated at:`, normaliza as quebras de linha e apara o arquivo. Assim, um arquivo que só difere no timestamp tem o mesmo checksum e é pulado.

Para cada arquivo, o `push` busca o último registro bem-sucedido:

| Situação | Arquivo de migration | Arquivo de policy, trigger ou RPC |
| --- | --- | --- |
| Nunca aplicado | Aplicado | Aplicado |
| Aplicado, mesmo checksum | Pulado (`already_applied`) | Pulado (`already_applied`) |
| Aplicado, checksum diferente | **Recusado** (`MIGRATION_DRIFT`) | Reaplicado (`re-applied: changed`) |

### Detecção de drift {#drift-detection}

Migrations aplicadas são imutáveis. Se alguém edita uma, o `push` para antes de aplicar qualquer outra coisa:

```
✗ Migration generated/migrations/20261029213510__init.sql changed after it was applied [MIGRATION_DRIFT]

  Fix: Applied migrations are immutable. Restore the file (e.g. `git checkout -- generated/migrations/20261029213510__init.sql`), change accessnexus.schema.ts instead and run `npx accessnexus generate` to get a new __changes migration.
```

Arquivos de policy, trigger e RPC são idempotentes, então um arquivo alterado simplesmente é aplicado de novo.

### Advisory lock

O `push` pega um advisory lock do Postgres (`pg_try_advisory_lock(hashtext('accessnexus_push_lock'))`) antes de aplicar qualquer coisa e o libera no final. Dois pushes no mesmo banco nunca se intercalam: o segundo avisa que outro push está com o lock e espera por ele.

### Uma transação, tudo ou nada {#one-transaction-all-or-nothing}

O push inteiro roda numa única transação: a tabela de controle, as remoções de policies estranhas, migrations, policies, triggers e RPCs. Se o arquivo 3 de 5 falhar, os arquivos 1 e 2 também sofrem rollback (`applied` é `[]`, `rolledBack` lista os dois, `failed` indica o arquivo 3), então o banco nunca fica com um push pela metade. Corrija a causa e rode o push de novo. A única coisa que uma transação única não permite: usar um valor de enum adicionado (`ALTER TYPE ... ADD VALUE`) antes, no mesmo push. Faça o push da mudança do enum primeiro.

::: info Policies que o AccessNexus não criou
As policies geradas se chamam `<prefix>_<table>_<operation>` (prefixo padrão `accessnexus`). O `push` só remove policies com esses nomes; policies criadas por outras ferramentas continuam lá. O Postgres combina policies permissivas com OR, então remova as policies antigas de forma deliberada quando as geradas já as cobrirem.
:::

## Saída determinística {#deterministic-output}

Por padrão, cada arquivo SQL começa com uma linha `-- Generated at: <timestamp>`. O corpo SQL abaixo dela é estável para o mesmo schema, e toda comparação remove a linha de timestamp:

- o `generate` não mexe num arquivo quando só essa linha mudaria (reportado como `unchanged`);
- o `diff` a ignora;
- o `push` a exclui do checksum.

Para uma saída idêntica byte a byte, por exemplo para revisar `generated/` em pull requests, desligue a linha de cabeçalho:

```ts [accessnexus.config.ts]
import { defineConfig } from 'accessnexus';

export default defineConfig({
  adapterOptions: {
    deterministic: true, // omite a linha de cabeçalho "Generated at"
  },
});
```

Os nomes dos arquivos de migration continuam levando o timestamp da execução do `generate` que os criou.

## Próximos passos {#next-steps}

- [CLI](/pt/guide/cli) - todos os comandos e flags
- [Modelo de segurança](/pt/guide/security) - o que o SQL gerado garante
- [Feito para agentes de código com IA](/pt/guide/ai-agents) - `--json`, exit codes e o ciclo do agente
- [Limites](/pt/guide/limits) - o que não é coberto
