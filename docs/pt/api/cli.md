# CLI

Referência completa do comando `accessnexus`. Fluxo de trabalho e exemplos: [guia da CLI](/pt/guide/cli).

```sh
npx accessnexus <command> [flags]
npx accessnexus <command> --help
```

| Comando | Para que serve | Mexe no banco |
| --- | --- | --- |
| [`init`](#init) | Configura o AccessNexus num projeto (schema, config, wrappers do SDK, AGENTS.md) | só com introspecção (somente leitura) |
| [`validate`](#validate) | Verifica o schema sem gravar nada | não |
| [`diff`](#diff) | Mostra o que o `generate` mudaria, sem gravar | não |
| [`generate`](#generate) | Grava migrations, policies de RLS, triggers, RPCs e o SDK tipado | não |
| [`push`](#push) | Aplica o SQL gerado no banco | sim |
| [`seed`](#seed) | Insere os dados de seed | sim |
| [`help`](#help-and-version) | Mostra a ajuda (também `--help`, `-h` ou sem comando) | não |
| [`version`](#help-and-version) | Imprime a versão instalada (também `--version`, `-v`) | não |

## Flags globais {#global-flags}

Aceitas por todos os comandos.

| Flag | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `--json` | boolean | `false` | Imprime exatamente um objeto JSON no stdout; sem cores, sem saída de progresso. |
| `--verbose` | boolean | `false` | Saída de debug no stderr e stack traces nos erros. O mesmo que `DEBUG=accessnexus`. |
| `--help`, `-h` | boolean | `false` | Mostra a ajuda do comando (com `--json`: a ajuda em JSON). |
| `--config <path>` | string | `accessnexus.config.{ts,js,mjs}` no cwd | Arquivo de config. Um caminho explícito inexistente gera `CONFIG_NOT_FOUND`. |

## Parsing de flags {#flag-parsing}

- As flags são estritas por comando: uma flag desconhecida gera `UNKNOWN_FLAG` (com sugestão do tipo "você quis dizer"), um argumento posicional gera `UNEXPECTED_ARGUMENT`.
- Flags de string aceitam `--flag value` e `--flag=value`. Valor ausente (fim do argv, ou o próximo token começa com `--`) gera `MISSING_FLAG_VALUE`.
- Flags booleanas não recebem valor: `--flag=x` gera `INVALID_FLAG_VALUE`.
- Aliases curtos: `-h` (`--help`), `-y` (`--yes`, só no `init`).
- Flags negativas são declaradas como tal (`--no-introspect`, `--no-agents`); não existe um `--no-<flag>` genérico.

## Resolução da config {#config-resolution}

1. `--config <path>`, se informado; senão, o primeiro entre `accessnexus.config.ts`, `accessnexus.config.js`, `accessnexus.config.mjs` no diretório atual. Não ter arquivo de config tudo bem: valem os padrões.
2. O arquivo é empacotado com esbuild e importado; o default export (ou o namespace do módulo) precisa ser um objeto (`CONFIG_INVALID`).
3. Os valores são combinados, com as flags primeiro:

| Configuração | Precedência |
| --- | --- |
| Arquivo de schema | `--schema` > `config.schema` > `./accessnexus.schema.ts` |
| Arquivo de seed (`seed`) | `--seed <path>` > `config.seed` > `./accessnexus.seed.ts` |
| Pastas de saída | `--output <dir>` (todas as categorias dentro de `<dir>`, pastas da config ignoradas) > `config.output.<category>` > `config.output.dir/<category>` > `./generated/<category>` |
| Prefixo das policies | `config.adapterOptions.policyPrefix` > `--prefix` > `config.naming.policyPrefix` > `accessnexus` |
| Só SQL / só SDK | `--sql-only` / `--sdk-only` ou `config.generate.sqlOnly` / `sdkOnly`; passar as duas flags gera `INVALID_FLAGS` |
| URL do banco | veja [URL do banco](#database-url) |

Todos os caminhos são resolvidos a partir do diretório de trabalho atual. Antes de rodar um comando, `.env` e `.env.local` do diretório atual são carregados; variáveis já definidas no ambiente não são sobrescritas.

## init

Configura o AccessNexus no projeto atual: `accessnexus.schema.ts` (template, ou importado do banco), `accessnexus.config.ts`, arquivos de wrapper do SDK, um script npm `accessnexus` e um bloco do AccessNexus no `AGENTS.md` (mais uma referência no `CLAUDE.md`, se ele existir).

| Flag | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `--yes`, `-y` | boolean | `false` | Não interativo: aceita os padrões, nunca pergunta. Obrigatório quando o stdin não é um TTY ou com `--json` (`INIT_NOT_INTERACTIVE`). |
| `--src <dir>` | string | detectado (`src` ou `.`) | Pasta de código-fonte. |
| `--sdk <dir>` | string | `<src>/lib/accessnexus` | Pasta de saída do SDK. |
| `--prefix <name>` | string | `accessnexus` | Prefixo dos nomes de policies. |
| `--db-url <url>` | string | nenhum | URL do Postgres para importar tabelas, policies de RLS e funções. Precisa do `pg`. |
| `--no-introspect` | boolean | `false` | Não lê o banco; grava um schema de template. |
| `--install` | boolean | `false` | Com `--yes`: instala os pacotes `@supabase/*` que faltarem. |
| `--force` | boolean | `false` | Com `--yes`: sobrescreve um `accessnexus.schema.ts` existente. |
| `--no-agents` | boolean | `false` | Não grava o bloco do AccessNexus no `AGENTS.md` / `CLAUDE.md`. |

Comportamento:

- Se `accessnexus.schema.ts` existe e `--force` não foi passado, o schema é mantido, o bloco do `AGENTS.md` é atualizado e o resultado tem `status: 'already_initialized'`.
- Com `--yes` numa pasta sem `package.json`, um mínimo (`"type": "module"`) é criado.
- Fonte da introspecção, salvo `--no-introspect`: `--db-url`; senão (não interativo) uma URL em `ACCESSNEXUS_DB_URL` / `SUPABASE_DB_URL` / `DATABASE_URL`; senão a API REST, com uma URL do Supabase e uma service key vindas dos arquivos `.env*` (só tabelas, sem policies). Caso contrário, um schema de template.

## validate

Carrega e verifica o schema; não grava nada.

| Flag | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `--schema <path>` | string | `config.schema` ou `./accessnexus.schema.ts` | Arquivo de schema. |

Sai com `1` e `SCHEMA_VALIDATION_FAILED` quando alguma issue tem severidade `error`; warnings são listados, mas não fazem falhar. Códigos de issue: [Erros](/pt/api/errors#schema-issues).

## generate

Grava migrations, policies, triggers, RPCs e o SDK. Roda antes as mesmas verificações do `validate`.

| Flag | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `--schema <path>` | string | `config.schema` ou `./accessnexus.schema.ts` | Arquivo de schema. |
| `--output <dir>` | string | `./generated` | Coloca todas as pastas de saída dentro de `<dir>`, sobrepondo os caminhos de saída da config. |
| `--sql-only` | boolean | `false` | Só SQL (migrations, policies, triggers, RPCs). |
| `--sdk-only` | boolean | `false` | Só o SDK tipado. |
| `--prefix <name>` | string | `accessnexus` | Prefixo dos nomes de policies. |

Saída:

| Pasta | Arquivos |
| --- | --- |
| migrations | `<UTC timestamp>__init.sql` na primeira execução, depois `<UTC timestamp>__changes.sql` quando o schema mudou; `.snapshot.json` (estado para o próximo diff). Formato do timestamp: `YYYYMMDDHHMMSS`. Nada novo quando o schema não mudou. Database mode: nenhuma. |
| policies | `<table>_rls.sql` |
| triggers | `<table>_triggers.sql` |
| rpcs | `rpcs.sql` |
| sdk | `types.ts` + `client.ts` (manual), `client.ts` (Database mode) |

Um arquivo cujo conteúdo difere só na linha `-- Generated at:` não é tocado (`unchanged`). Statements destrutivos nas migrations gravadas nesta execução são reportados em `destructive`.

## diff

Mostra o que o `generate` mudaria; não grava nada. Rode antes do `generate`: depois dele não sobra nada para comparar.

| Flag | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `--schema <path>` | string | `config.schema` ou `./accessnexus.schema.ts` | Arquivo de schema. |
| `--output <dir>` | string | `./generated` | Compara com as pastas dentro de `<dir>`. |
| `--sql-only` | boolean | `false` | Só SQL. |
| `--sdk-only` | boolean | `false` | Só o SDK. |
| `--prefix <name>` | string | `accessnexus` | Prefixo dos nomes de policies. |
| `--check` | boolean | `false` | Sai com `1` e `GENERATED_OUT_OF_DATE` quando algo mudaria (para CI). |

Arquivos removidos são reportados para policies, triggers e RPCs (um `.sql` sobrando nessas pastas). As pastas de migrations e do SDK nunca reportam remoções.

## push

Aplica o SQL gerado no banco.

| Flag | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `--url <db-url>` | string | veja [URL do banco](#database-url) | Connection string do Postgres. |
| `--adapter <name>` | string | nenhum | Adapter a usar quando `config.adapters` lista vários. |
| `--target <name>` | string | nenhum | Entrada de `config.targets`. |
| `--dry-run` | boolean | `false` | Lista os arquivos e os statements destrutivos; não conecta. |
| `--output <dir>` | string | `./generated` | Lê o SQL das pastas dentro de `<dir>`. |
| `--prefix <name>` | string | `accessnexus` | Prefixo dos nomes de policies (usado na verificação de defasagem). |
| `--schema <path>` | string | `config.schema` ou `./accessnexus.schema.ts` | Arquivo de schema (usado na verificação de defasagem). |
| `--allow-destructive` | boolean | `false` | Aplica migrations pendentes que removem tabelas/colunas, removem tipos, fazem truncate ou mudam tipos de coluna. |
| `--seed` | boolean | `false` | Roda também o seed depois do push. |
| `--allow-remote-seed` | boolean | `false` | Com `--seed`: permite rodar seed num banco Supabase hospedado. |

Etapas, em ordem:

1. Coleta os arquivos `.sql` (recursivamente, ordenados por caminho) das pastas migrations, policies, triggers e rpcs. Nenhum: `NOTHING_TO_PUSH`.
2. Sem `--dry-run`: exige uma URL de banco (`DB_URL_MISSING`) e o driver `pg` (`PG_DRIVER_MISSING`).
3. Regera o SQL em memória e compara com os arquivos: qualquer diferença gera `GENERATED_OUT_OF_DATE` (também com `--dry-run`).
4. O `--dry-run` para aqui.
5. Conecta (`DB_CONNECTION_FAILED`). Se algum arquivo contém `SECURITY DEFINER`, a role precisa ignorar o RLS (`PUSH_ROLE_NO_BYPASSRLS`).
6. Obtém um advisory lock (espera, com um aviso, se outro push estiver com ele). Cria `public.accessnexus_migrations` (RLS habilitado e forçado), a extensão `pgcrypto` e uma função de compatibilidade `public.uuid_generate_v7()`, se não existirem.
7. Se uma migration ainda não aplicada contém um statement destrutivo e `--allow-destructive` não foi passado: `DESTRUCTIVE_MIGRATION`, nada é aplicado.
8. Aplica os arquivos na ordem migrations, policies, triggers, rpcs; cada arquivo na sua própria transação. Checksum: SHA-256 do SQL sem a linha `-- Generated at:`.
   - inalterado e já aplicado: pulado (`already_applied`);
   - uma migration aplicada cujo conteúdo mudou: `MIGRATION_DRIFT`;
   - um arquivo de policy, trigger ou RPC alterado: reaplicado;
   - erro de SQL: esse arquivo sofre rollback, `PUSH_FAILED`; os arquivos já em `applied` continuam aplicados.
9. Com `--seed`: roda o seed (veja `seed`). Arquivo de seed ausente gera `SEED_NOT_FOUND`; um seed que falha mantém o push e reporta o error code do seed.

SSL: forçado (sem verificar o certificado) quando a URL tem `sslmode=require|verify-ca|verify-full`, ou o host contém `supabase.co` / `supabase.in`, a menos que a URL tenha `sslmode=disable`.

::: warning
O `push` é o único comando que altera o banco. Veja a prévia com `--dry-run`. O `--allow-destructive` apaga dados; use só quando a perda for intencional e houver backup. Um rename se faz no schema, não como remover + adicionar.
:::

## seed

Gera o SQL de seed a partir do arquivo de seed e o executa numa única transação.

| Flag | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `--url <db-url>` | string | veja [URL do banco](#database-url) | Connection string do Postgres. |
| `--adapter <name>` | string | nenhum | Adapter a usar quando há vários configurados. |
| `--target <name>` | string | nenhum | Entrada de `config.targets`. |
| `--dry-run` | boolean | `false` | Imprime o SQL; não conecta. |
| `--schema <path>` | string | `config.schema` ou `./accessnexus.schema.ts` | Arquivo de schema. |
| `--prefix <name>` | string | `accessnexus` | Prefixo dos nomes de policies. |
| `--seed <path>` | string | `config.seed` ou `./accessnexus.seed.ts` | Arquivo de seed. |
| `--allow-remote-seed` | boolean | `false` | Permite rodar seed num banco Supabase hospedado (`*.supabase.co`, `*.supabase.com`, `*.supabase.in`). |

Erros: `SEED_NOT_FOUND`, `SEED_EMPTY` (o export não tem tabelas), `SEED_REMOTE_BLOCKED`, `SEED_FAILED` (com rollback). Formato do seed: [defineSeed](/pt/api/seed-config#defineseed).

::: warning
Seeds fazem upsert de linhas e podem criar contas em `auth.users`. Rode só em bancos locais ou descartáveis.
:::

## help e version {#help-and-version}

| Invocação | Saída |
| --- | --- |
| `accessnexus`, `accessnexus help`, `--help`, `-h` | visão geral |
| `accessnexus help <command>`, `accessnexus <command> --help` | flags e exemplos do comando |
| `accessnexus version`, `--version`, `-v` | string da versão |

Todos aceitam `--json`.

## URL do banco {#database-url}

`push` e `seed` usam o primeiro valor não vazio entre:

1. `--url`
2. a variável de ambiente indicada por `adapterOptions.dbUrlEnv` do target ou adapter selecionado (ou `adapterOptions.datasource.url.env`)
3. `ACCESSNEXUS_DB_URL`
4. `SUPABASE_DB_URL`
5. `DATABASE_URL`

No Supabase, use a connection string do "Session pooler" (Dashboard, Connect), com a role `postgres`. As senhas são ocultadas nas mensagens.

## Variáveis de ambiente {#environment-variables}

| Variável | Usada por | Descrição |
| --- | --- | --- |
| `ACCESSNEXUS_DB_URL` | `push`, `seed`, `init` | URL do banco (depois de `--url` e `dbUrlEnv`). |
| `SUPABASE_DB_URL` | `push`, `seed`, `init` | Fallback da URL do banco. |
| `DATABASE_URL` | `push`, `seed`, `init` | Fallback da URL do banco. |
| `<dbUrlEnv>` | `push`, `seed` | Qualquer nome configurado em `adapterOptions.dbUrlEnv`. |
| `ACCESSNEXUS_DB_CONNECT_TIMEOUT` | `push`, `seed`, `init --db-url` | Timeout de conexão em segundos (número positivo). Padrão `10`. |
| `ACCESSNEXUS_SEED_PASSWORD` | `seed`, `push --seed` | Senha das linhas de `auth.users` que o seed provisiona. Padrão: aleatória por usuário. |
| `DEBUG` | todos | `accessnexus`, `accessnexus*` ou `*` (separados por vírgula ou espaço) ativa o `--verbose`. |
| `NO_COLOR` | todos | Qualquer valor não vazio desliga as cores. |
| `FORCE_COLOR` | todos | Qualquer valor diferente de `0` liga as cores quando o stdout não é um TTY. Ignorada com `--json`. |
| `NEXT_PUBLIC_SUPABASE_URL`, `VITE_SUPABASE_URL`, `REACT_APP_SUPABASE_URL`, `SUPABASE_URL` | `init` | URL do projeto para a introspecção via REST, lida de `.env`, `.env.local`, `.env.development`, `.env.development.local`. |
| `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SERVICE_ROLE`, `SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_KEY`, `SERVICE_ROLE_KEY` | `init` | Service key para a introspecção via REST (qualquer valor que comece com `sb_secret_` tem preferência). |

As cores ficam desligadas quando o stdout não é um TTY, com `NO_COLOR` e sempre com `--json`.

## Exit codes {#exit-codes}

| Código | Significado |
| --- | --- |
| `0` | Sucesso. |
| `1` | Erro corrigível pelo usuário: flag inválida, arquivo ausente, erro no schema, URL do banco ausente, banco inacessível, SQL rejeitado, saída desatualizada, migration destrutiva sem `--allow-destructive`, seed com falha. Leia o `error.hint`. |
| `2` | Erro interno (`INTERNAL_ERROR`): um bug do AccessNexus. Rode de novo com `--verbose` e reporte o stack trace. |

Error codes: [Erros](/pt/api/errors).

## Saída JSON {#json-output}

Com `--json`, o stdout traz exatamente um objeto JSON (formatado). Todo objeto tem `ok`, `command` e `version`. Em caso de falha, ele também tem `error` e mantém os campos de resultado parcial carregados pelo erro (`issues`, `applied`, `stale`, ...). Sem `--json`, os erros vão para o stderr como mensagem, hint `Fix:` e (com `--verbose`) stack.

```ts
interface SchemaIssue {
  severity: 'error' | 'warning';
  code: string;        // e.g. 'UNKNOWN_COLUMN'
  path: string;        // e.g. 'posts.policies.update'
  message: string;
  hint?: string;
}

interface ErrorResult {
  ok: false;
  command: string;     // the command as typed (also for UNKNOWN_COMMAND)
  version: string;
  error: { code: string; message: string; hint?: string; stack?: string /* --verbose */ };
  // SCHEMA_VALIDATION_FAILED adds: schemaPath, issues (errors and warnings), summary { errors, warnings }
  //   (validate also adds mode, tables, rpcs)
  [partial: string]: unknown;
}

interface DestructiveStatement {
  file: string;        // migration file, relative to cwd
  line: number;        // 1-based
  kind: 'drop_table' | 'drop_column' | 'alter_column_type' | 'drop_type' | 'truncate';
  sql: string;
}

interface ValidateResult {
  ok: true; command: 'validate'; version: string;
  schemaPath: string;
  mode: 'manual' | 'database';
  tables: Array<{
    name: string;
    columns: number;
    primaryKey: string | null;
    rls: boolean;
    policies: string[];                                   // operations with a rule
    triggers: Array<{ kind: string; name: string | null }>;
  }>;
  rpcs: string[];
  issues: SchemaIssue[];                                  // warnings only
  summary: { errors: number; warnings: number };
}

interface GenerateResult {
  ok: true; command: 'generate'; version: string;
  schemaPath: string;
  mode: 'manual' | 'database';
  files: Array<{
    path: string;
    category: 'migrations' | 'policies' | 'triggers' | 'rpcs' | 'sdk';
    status: 'created' | 'updated' | 'unchanged';
  }>;
  destructive: DestructiveStatement[];                    // in migrations written by this run
  summary: { created: number; updated: number; unchanged: number; files: number; tables: number };
  warnings: SchemaIssue[];
}

interface DiffResult {
  ok: boolean;          // false only with --check and pending changes (GENERATED_OUT_OF_DATE)
  command: 'diff'; version: string;
  schemaPath: string;
  changed: boolean;
  destructive: DestructiveStatement[];                    // in migrations generate would write
  summary: { added: number; modified: number; removed: number };
  changes: Array<{ path: string; status: 'added' | 'modified' | 'removed'; diff: string }>;
  warnings: SchemaIssue[];
}

interface PushResult {
  ok: true; command: 'push'; version: string;
  dryRun: boolean;
  adapter: string;
  target: string | null;
  plan: Array<{ category: 'migrations' | 'policies' | 'triggers' | 'rpcs'; files: string[] }>;
  destructive?: DestructiveStatement[];                   // --dry-run only: all migration files
  applied: string[];
  skipped: Array<{ path: string; reason: 'already_applied' | 'checksum_normalized' }>;
  seed:
    | null                                                // no --seed (always null with --dry-run)
    | { path: string; status: 'applied'; authUsers: number; durationMs: number }
    | { path: string; status: 'skipped'; message: string; authUsers: 0 };
}
// push failures keep partial fields:
//   NOTHING_TO_PUSH          dryRun, adapter, target, plan
//   GENERATED_OUT_OF_DATE    dryRun, adapter, target, plan, stale: Array<{ path: string; status: string }>
//   DESTRUCTIVE_MIGRATION    ...plan, applied, skipped, destructive
//   MIGRATION_DRIFT, PUSH_FAILED, SEED_NOT_FOUND   ...plan, applied, skipped
//   seed failure (any code)  ...plan, applied, skipped, seed: { path, status: 'failed', message }

interface SeedResult {
  ok: true; command: 'seed'; version: string;
  dryRun: boolean;
  seedPath: string;
  checksum: string;     // SHA-256 of the seed SQL
  rows: number;         // rows in the seed file
  authUsers: number;    // auth.users rows the seed provisions
  applied: boolean;
  sql?: string;         // --dry-run
  durationMs?: number;  // when applied
}

interface InitResult {
  ok: true; command: 'init'; version: string;
  status: 'initialized' | 'already_initialized';
  framework?: string;
  schemaSource?: 'template' | 'database' | 'rest';
  sdkPath?: string;
  policyPrefix?: string;
  installed?: string[];
  files: Array<{ path: string; action: 'created' | 'updated' | 'skipped' }>;
  agents: null | { agentsMd: 'created' | 'updated' | 'unchanged'; claudeMd: 'updated' | 'unchanged' | 'absent' };
  nextSteps?: string[];
}

interface HelpResult {
  ok: true; command: 'help'; version: string;
  topic: string | null;
  commands: Array<{
    name: string;
    summary: string;
    examples: string[];
    flags: Array<{ name: string; kind: 'boolean' | 'string'; value?: string; description: string }>;
  }>;
  exitCodes: Record<'0' | '1' | '2', string>;
  docs: string;         // 'node_modules/accessnexus/llms.txt'
}

interface VersionResult { ok: true; command: 'version'; version: string }
```
