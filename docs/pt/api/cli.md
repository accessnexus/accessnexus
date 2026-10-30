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
| `--check` | boolean | `false` | Sai com `1` e `GENERATED_OUT_OF_DATE` quando algo mudaria (para CI). Com `--against-db`: sai com `1` e `LIVE_DB_CHANGES` quando o banco mudaria. |
| `--against-db` | boolean | `false` | Plano de mudanças no banco real: ensaia o push contra o banco (veja abaixo). |
| `--url <db-url>` | string | veja [URL do banco](#database-url) | Com `--against-db`. Alias: `--db-url`. |
| `--adapter <name>` / `--target <name>` | string | nenhum | Com `--against-db`: mesma resolução do `push`. |
| `--allow-destructive` | boolean | `false` | Com `--against-db`: planeja como o `push --allow-destructive` faria (senão vira um blocker `DESTRUCTIVE_MIGRATION`). |
| `--replace-foreign-policies` / `--replace-foreign-triggers` | boolean | `false` | Com `--against-db`: inclui os drops que o push faria com essas flags (senão viram blockers `FOREIGN_*`). |

Arquivos removidos são reportados para policies, triggers e RPCs (um `.sql` sobrando nessas pastas). As pastas de migrations e do SDK nunca reportam remoções.

Sem `--against-db`, o `diff` compara o schema com os **arquivos** gerados, não com o banco. Quando há uma URL de banco configurada, o resultado traz um `hint` apontando para o `--against-db`.

### Plano contra o banco (`--against-db`) {#live-plan-against-db}

O `diff --against-db` mostra o que o `push` mudaria de fato no banco. Funciona por ensaio:

1. Gera o SQL do schema atual em memória (o que `generate` + `push` aplicariam) e conecta (`DB_URL_MISSING`, `PG_DRIVER_MISSING`, `DB_CONNECTION_FAILED`).
2. Pega o advisory lock do push sem esperar: se um push estiver rodando, `PUSH_LOCKED`.
3. `BEGIN` e um snapshot do catálogo de tudo que o schema gerencia: tabelas, RLS ligado/forçado, colunas (tipo via `format_type`, nulabilidade, default via `pg_get_expr`), constraints, índices, policies (comando, permissive, roles, `USING`/`WITH CHECK`), triggers (momento, eventos, nível, `WHEN`, função), as funções que o SQL define ou que os triggers chamam (argumentos, retorno, linguagem, volatilidade, security definer, `proconfig`, hash do corpo, `pg_get_functiondef`) e os grants dessas tabelas e funções.
4. Roda o caminho de código do push na transação: os mesmos drops de policies/triggers estranhos (só com as flags `--replace-*`), as mesmas regras de pular/reaplicar, os mesmos arquivos na mesma ordem.
5. Tira o snapshot de novo, `ROLLBACK`, libera o lock. Nada persiste: nenhum objeto, nenhuma linha em `accessnexus_migrations`.

O resultado lista `changes` (`kind`, `object`, `change`, `before`, `after`, `fields`) e `riskyChanges`: mudança de volatilidade/config/security de função, roles de policy ampliadas (por exemplo `authenticated` → `public`), policies, triggers, funções, tabelas ou colunas removidas, default de coluna removido, mudança de tipo, `NOT NULL` relaxado, RLS desligado ou sem FORCE, e grants. Os grants são julgados pelo acesso **efetivo** (`has_function_privilege` / `has_table_privilege` para `anon` e `authenticated`, mais a entrada `PUBLIC` da ACL), não pela forma literal da ACL: `grant_widened` quando um deles ganha um privilégio num objeto que já existia, `grant_narrowed` quando perde (`PUBLIC` perdendo um privilégio que `anon` e `authenticated` mantêm, como no `REVOKE ... FROM PUBLIC` mais grants diretos de uma RPC definer, não é sinalizado). Uma mudança de grant traz `notes` com o caminho de acesso por role, ex. `anon EXECUTE: via PUBLIC → direct grant (no change in access)`; `before`/`after` mantêm a ACL literal (`privileges`) ao lado de `effective`. Com `--replace-foreign-triggers`, `keptTriggerFunctions` lista as funções dos triggers removidos (nunca removidas) e o que ainda depende delas. As recusas em que o push real pararia (`FOREIGN_POLICIES`, `FOREIGN_TRIGGERS`, `DESTRUCTIVE_MIGRATION`, `PUSH_ROLE_NO_BYPASSRLS`) ficam em `blockers`. Se o Postgres rejeitaria um arquivo, o comando sai com `1` e `PUSH_WOULD_FAIL`, com `failed` (`file`, `message`, `sqlState`); nada foi persistido.

```bash
npx accessnexus diff --against-db --json
npx accessnexus diff --against-db --check     # CI: sai com 1 quando o push mudaria o banco
```

## push

Aplica o SQL gerado no banco.

| Flag | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `--url <db-url>` | string | veja [URL do banco](#database-url) | Connection string do Postgres. Alias: `--db-url` (a flag que o `init` usa); passar as duas com valores diferentes gera `INVALID_FLAG_VALUE`. |
| `--adapter <name>` | string | nenhum | Adapter a usar quando `config.adapters` lista vários. |
| `--target <name>` | string | nenhum | Entrada de `config.targets`. |
| `--dry-run` | boolean | `false` | Lista os arquivos e os statements destrutivos. Com uma URL de banco, também ensaia o push dos arquivos em disco numa transação desfeita ([plano contra o banco](#live-plan-against-db), em `livePlan`) e lista policies e triggers estranhos (`foreignPolicies`, `foreignTriggers`, `wouldRefuse`); sem URL, esses campos são `null`. Nada persiste. |
| `--output <dir>` | string | `./generated` | Lê o SQL das pastas dentro de `<dir>`. |
| `--prefix <name>` | string | `accessnexus` | Prefixo dos nomes de policies (usado na verificação de defasagem). |
| `--schema <path>` | string | `config.schema` ou `./accessnexus.schema.ts` | Arquivo de schema (usado na verificação de defasagem). |
| `--allow-destructive` | boolean | `false` | Aplica migrations pendentes que removem tabelas/colunas, removem tipos, fazem truncate ou mudam tipos de coluna. |
| `--replace-foreign-policies` | boolean | `false` | Remove as policies de RLS das tabelas gerenciadas que o AccessNexus não gerou, dentro da transação do push (veja a etapa 7). |
| `--replace-foreign-triggers` | boolean | `false` | Remove os triggers das tabelas gerenciadas que o AccessNexus não gerou, dentro da transação do push (sem a flag: `FOREIGN_TRIGGERS`). |
| `--seed` | boolean | `false` | Roda também o seed depois do push. |
| `--allow-remote-seed` | boolean | `false` | Com `--seed`: permite rodar seed num banco Supabase hospedado. |

Etapas, em ordem:

1. Coleta os arquivos `.sql` (recursivamente, ordenados por caminho) das pastas migrations, policies, triggers e rpcs. Nenhum: `NOTHING_TO_PUSH`.
2. Sem `--dry-run`: exige uma URL de banco (`DB_URL_MISSING`) e o driver `pg` (`PG_DRIVER_MISSING`).
3. Regera o SQL em memória e compara com os arquivos: qualquer diferença gera `GENERATED_OUT_OF_DATE` (também com `--dry-run`).
4. O `--dry-run` para aqui (depois do ensaio do [plano contra o banco](#live-plan-against-db), quando há URL de banco).
5. Conecta (`DB_CONNECTION_FAILED`). Se algum arquivo contém `SECURITY DEFINER`, a role precisa ignorar o RLS (`PUSH_ROLE_NO_BYPASSRLS`).
6. Obtém um advisory lock (espera, com um aviso, se outro push estiver com ele) e abre (`BEGIN`) uma única transação para tudo o que vem abaixo. Cria `public.accessnexus_migrations` (RLS habilitado e forçado), se não existir.
7. Lê `pg_policies` de cada tabela que o schema gerencia. Uma policy cujo nome não é um dos que o AccessNexus gera (`<prefix>_<table>_<op>`) é estranha: o Postgres combina policies permissivas com OR, então ela continuaria concedendo acesso ao lado das geradas. Sem `--replace-foreign-policies`: `FOREIGN_POLICIES` (a mensagem e `foreignPolicies` listam tabela + policy), nada é aplicado. Com a flag: elas são removidas (`droppedPolicies`) dentro da transação.
8. Se uma migration ainda não aplicada contém um statement destrutivo e `--allow-destructive` não foi passado: `DESTRUCTIVE_MIGRATION`, nada é aplicado.
9. Aplica os arquivos na ordem migrations, policies, triggers, rpcs, registrando cada um em `accessnexus_migrations`. Checksum: SHA-256 do SQL sem a linha `-- Generated at:`.
   - inalterado e já aplicado: pulado (`already_applied`);
   - uma migration aplicada cujo conteúdo mudou: `MIGRATION_DRIFT`;
   - um arquivo de policy, trigger ou RPC alterado: reaplicado;
   - erro de SQL: `PUSH_FAILED` (`failed` indica o arquivo).
10. `COMMIT`. Qualquer erro antes disso desfaz o push inteiro: não sobra nenhuma migration, policy, trigger, RPC, registro de controle nem remoção de policy desse push (`applied` é `[]`, `rolledBack` lista os arquivos que tinham rodado). O advisory lock é liberado nos dois casos.
11. Com `--seed`: roda o seed (veja `seed`). Arquivo de seed ausente gera `SEED_NOT_FOUND`; um seed que falha mantém o push e reporta o error code do seed.

SSL: forçado (sem verificar o certificado) quando a URL tem `sslmode=require|verify-ca|verify-full`, ou o host contém `supabase.co` / `supabase.in`, a menos que a URL tenha `sslmode=disable`.

::: warning
O `push` é o único comando que altera o banco. Veja a prévia com `--dry-run`. O Postgres não deixa usar, na mesma transação, um valor de enum adicionado por `ALTER TYPE ... ADD VALUE`: se um push adiciona um valor de enum e também o usa (num default, numa policy ou numa RPC), faça o push da mudança do enum primeiro e depois o resto. O `--allow-destructive` apaga dados; use só quando a perda for intencional e houver backup. Um rename se faz no schema, não como remover + adicionar.
:::

## seed

Gera o SQL de seed a partir do arquivo de seed e o executa numa única transação.

| Flag | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `--url <db-url>` | string | veja [URL do banco](#database-url) | Connection string do Postgres. Alias: `--db-url` (a flag que o `init` usa); passar as duas com valores diferentes gera `INVALID_FLAG_VALUE`. |
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

1. `--url` (ou o alias `--db-url`)
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
  hint?: string;        // set when a database URL is configured: points to diff --against-db
}

// diff --against-db: the live plan (PlanChange, RiskyChange and LivePlan are spelled out in llms.txt)
interface DiffAgainstDbResult extends LivePlan {
  ok: boolean;          // false with --check and changes (LIVE_DB_CHANGES) or when the push would fail (PUSH_WOULD_FAIL)
  command: 'diff'; version: string;
  schemaPath: string;
  againstDb: true;
  adapter: string; target: string | null;
  generatedUpToDate: boolean;                             // false: planned from the schema, run generate before push
  warnings: SchemaIssue[];
}

interface LivePlan {
  database: string;                                       // redacted URL
  wouldApply: string[];                                   // files push would execute
  skipped: Array<{ path: string; reason: 'already_applied' | 'checksum_normalized' }>;
  droppedPolicies: ForeignPolicy[]; droppedTriggers: ForeignTrigger[]; // only with the --replace-* flags
  keptTriggerFunctions: Array<{ function: string; dependents: string[]; orphaned: boolean }>; // functions of dropped triggers (kept)
  foreignPolicies: ForeignPolicy[]; foreignTriggers: ForeignTrigger[];
  blockers: Array<{ code: string; message: string; hint?: string }>; // refusals the real push stops at
  failed: null | { file: string | null; code: string; message: string; sqlState: string | null };
  changed: boolean;
  summary: { added: number; modified: number; removed: number };
  changes: Array<{
    kind: 'table' | 'column' | 'constraint' | 'index' | 'rls' | 'policy' | 'trigger' | 'function' | 'grant';
    object: string;                                       // e.g. 'public.notes.accessnexus_notes_select', 'public.fn(uuid)'
    change: 'added' | 'removed' | 'modified';
    before?: Record<string, unknown>; after?: Record<string, unknown>;
    fields?: string[];                                    // modified: properties that differ
    notes?: string[];                                     // grants: access path per role, e.g. 'anon EXECUTE: via PUBLIC → direct grant (no change in access)'
  }>;
  riskyChanges: Array<{ code: string; kind: string; object: string; message: string }>;
  persisted: false;
}

interface PushResult {
  ok: true; command: 'push'; version: string;
  dryRun: boolean;
  adapter: string;
  target: string | null;
  plan: Array<{ category: 'migrations' | 'policies' | 'triggers' | 'rpcs'; files: string[] }>;
  destructive?: DestructiveStatement[];                   // --dry-run only: all migration files
  foreignPolicies?: ForeignPolicy[] | null;               // --dry-run only: null = no database URL, not checked
  wouldRefuse?: boolean;                                  // --dry-run only: foreign policies/triggers without their --replace-* flag, or livePlan blockers/failed
  livePlan?: LivePlan | null;                             // --dry-run only: null = no database URL (or unreachable)
  applied: string[];
  droppedPolicies: ForeignPolicy[];                       // dropped by --replace-foreign-policies
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
//   FOREIGN_POLICIES         ...plan, applied: [], skipped, foreignPolicies
//   MIGRATION_DRIFT, PUSH_FAILED   ...plan, applied: [] (rolled back), skipped, rolledBack: string[]; PUSH_FAILED adds failed: string
//   SEED_NOT_FOUND           ...plan, applied, skipped
//   seed failure (any code)  ...plan, applied, skipped, seed: { path, status: 'failed', message }

interface ForeignPolicy {
  schema: string; table: string; policy: string;
  command: string;      // SELECT | INSERT | UPDATE | DELETE | ALL
  permissive: boolean;  // false = RESTRICTIVE
}

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
