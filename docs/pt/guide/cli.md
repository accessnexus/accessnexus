# CLI

A CLI `accessnexus` transforma o `accessnexus.schema.ts` em SQL e num SDK tipado, e aplica esse SQL no seu banco. Esta página percorre a CLI por tarefa. Para todas as flags de todos os comandos, veja a [referência da CLI](/pt/api/cli).

```bash
npx accessnexus <command> [flags]
npx accessnexus <command> --help
```

O ciclo do dia a dia é o mesmo para pessoas e para coding agents:

```bash
npx accessnexus validate          # 1. checa o schema
npx accessnexus diff              # 2. revisa o SQL que mudaria
npx accessnexus generate          # 3. escreve SQL + SDK
npx accessnexus diff --against-db # 4. o que o push mudaria de fato no banco (riskyChanges)
npx accessnexus push              # 5. aplica
```

O `init` também adiciona um script npm, `"accessnexus": "accessnexus generate"`, então `npm run accessnexus` gera tudo de novo.

## Comportamento comum a todos os comandos {#behavior-shared-by-every-command}

| Comportamento | Detalhes |
| --- | --- |
| `--json` | Imprime exatamente um objeto JSON no stdout e nada mais (sem cores). Todo resultado tem `ok`, `command` e `version`; falhas acrescentam `error: { code, message, hint }`. |
| Exit codes | `0` sucesso, `1` algo que você pode corrigir (leia `error.hint`), `2` um bug do AccessNexus (rode de novo com `--verbose` e reporte o stack). |
| `--verbose` | Saída de debug e stack traces. Equivale a `DEBUG=accessnexus`. |
| `--config <path>` | Arquivo de config. Padrão: `accessnexus.config.ts`, `.js` ou `.mjs` na pasta atual. |
| Sem prompts sem TTY | Nada fica esperando entrada quando o stdin não é um terminal. Nesse caso o `init` exige `--yes`. |
| Flags estritas | Comandos e flags desconhecidos falham (`UNKNOWN_COMMAND`, `UNKNOWN_FLAG`) com uma sugestão do tipo "você quis dizer". Eles nunca são ignorados. |
| Cores | Desligadas quando o stdout não é um TTY ou quando `NO_COLOR` está definida. |

## Configure um projeto: `init` {#set-up-a-project-init}

```bash
npx accessnexus init               # interativo
npx accessnexus init --yes         # aceita os padrões, nunca pergunta
```

O `init` detecta o framework (Next.js com app ou pages router, Vite, Create React App, Node puro), escreve `accessnexus.schema.ts`, `accessnexus.config.ts`, wrappers de client junto à pasta do SDK (padrão `<src>/lib/accessnexus`), o script npm e um bloco do AccessNexus no `AGENTS.md`. Numa pasta vazia, `init --yes` primeiro cria um `package.json` mínimo.

| Flag | Efeito |
| --- | --- |
| `--yes`, `-y` | Não interativo. Obrigatório sem TTY (senão, `INIT_NOT_INTERACTIVE`). |
| `--db-url <url>` | Importa tabelas, chaves, policies de RLS e funções de um banco existente. |
| `--no-introspect` | Nunca conecta a um banco; escreve um schema de exemplo. |
| `--src <dir>`, `--sdk <dir>`, `--prefix <name>` | Pasta de código-fonte, pasta do SDK, prefixo dos nomes das policies. |
| `--install` | Com `--yes`: instala os pacotes `@supabase/*` que faltam. |
| `--force` | Com `--yes`: sobrescreve um `accessnexus.schema.ts` existente. |
| `--no-agents` | Não escreve o bloco no `AGENTS.md` / `CLAUDE.md`. |

Rodar o `init` de novo é seguro: um schema existente é mantido (a menos que `--force`) e o bloco do `AGENTS.md` é substituído no lugar.

::: warning `init --yes` importa quando encontra credenciais
Com `--yes` e sem `--no-introspect`, o `init` importa do banco sempre que encontra uma URL em `ACCESSNEXUS_DB_URL`, `SUPABASE_DB_URL` ou `DATABASE_URL` (inclusive em `.env` / `.env.local`), ou uma URL do Supabase junto com uma secret key nos seus arquivos de env. Passe `--no-introspect` para um schema de exemplo. Adotar um banco existente é assunto de [Projetos existentes](/pt/guide/existing-project).
:::

## Cheque o schema: `validate` {#check-the-schema-validate}

```bash
npx accessnexus validate
npx accessnexus validate --json
```

Carrega o schema e roda as checagens estáticas: tabelas e colunas desconhecidas em policies, tipos de coluna errados, nomes reservados, regras de escrita abertas a visitantes anônimos, guards de tenant faltando e mais. Não escreve nada. Erros saem com `1` (`SCHEMA_VALIDATION_FAILED`, com todos os problemas em `issues[]`); warnings são impressos, mas saem com `0`.

No modo manual, o TypeScript não checa nomes de coluna dentro de `policy.*` e `definePermissions` (`policy.isOwner('usr_id')` compila). O `validate` checa, então rode-o depois de cada edição no schema. `generate`, `diff` e `push` rodam as mesmas checagens e param em caso de erro.

A lista completa de checagens está nas páginas [Modelo de segurança](/pt/guide/security#what-validate-warns-about) e [Solução de problemas](/pt/guide/troubleshooting#schema-validation-issues).

## Revise a mudança: `diff` {#review-the-change-diff}

```bash
npx accessnexus diff
npx accessnexus diff --json
npx accessnexus diff --check      # exit 1 quando os arquivos gerados estão desatualizados (para CI)
```

O `diff` calcula o que o `generate` escreveria e compara com os arquivos em disco, imprimindo só os trechos alterados. Rode-o **antes** do `generate`: logo depois do `generate` não sobra nada para mostrar. Para revisar depois, use `git diff generated/`.

Ele também lista os statements `destructive` (tabelas ou colunas removidas, mudanças de tipo de coluna) na migration que escreveria. Uma renomeação deve ser uma renomeação no schema, não uma remoção mais uma adição.

`--check` transforma mudanças pendentes em falha: exit `1`, `error.code` `GENERATED_OUT_OF_DATE`, `ok: false` no JSON. Uma diferença só na linha de cabeçalho `-- Generated at:` nunca conta como mudança.

### Contra o banco real: `diff --against-db` {#against-the-live-database-diff-against-db}

O `diff` simples compara o schema com os arquivos gerados, não com o banco: mudanças feitas direto no banco (Studio, SQL escrito à mão, um projeto importado) ficam invisíveis para ele. O `diff --against-db` responde "o que o `push` vai mudar de fato?":

```bash
npx accessnexus diff --against-db
npx accessnexus diff --against-db --json
npx accessnexus diff --against-db --check   # CI: sai com 1 quando o push mudaria o banco
```

Ele conecta com a mesma resolução de URL do `push`, pega o lock do push (sem esperar), abre uma transação, tira um snapshot do catálogo das tabelas e funções gerenciadas, aplica exatamente o que o `push` aplicaria, tira outro snapshot e desfaz tudo (rollback). Nada persiste. A saída é agrupada por tipo, com `antes → depois` para cada propriedade alterada:

```text
  Policies:
    ~ public.notes.accessnexus_notes_select
        using: (owner_id = ( SELECT auth.uid() AS uid)) → true
  Functions:
    ~ public.note_count() (risky)
        volatility: STABLE → VOLATILE
        config: search_path=public, work_mem=64MB → search_path=pg_catalog, public

  ⚠ Risky changes: 2
    ! [function_volatility_changed] function public.note_count() STABLE → VOLATILE
    ! [function_config_changed] function public.note_count() config [...] → [...]
```

Revise os `riskyChanges` (mudanças de volatilidade e de config `SET`, roles de policy ampliadas, policies removidas, defaults perdidos, mudanças de tipo, RLS desligado, `grant_widened` / `grant_narrowed` pelo acesso efetivo) antes do push. Passe as mesmas `--replace-foreign-policies`, `--replace-foreign-triggers` ou `--allow-destructive` que passaria ao `push` para ver o efeito delas; sem elas, as recusas aparecem em `blockers`. Se o Postgres rejeitaria um arquivo, o comando sai com `1` e `PUSH_WOULD_FAIL`, com o arquivo e o erro SQL. O `push --dry-run` roda o mesmo plano automaticamente (em `livePlan`) quando há URL de banco.

## Escreva o SQL e o SDK: `generate` {#write-sql-and-the-sdk-generate}

```bash
npx accessnexus generate
npx accessnexus generate --sql-only               # migrations, policies, triggers, RPCs
npx accessnexus generate --sdk-only               # types.ts + client.ts
npx accessnexus generate --output ./tmp/preview   # tudo em outra pasta
```

| Saída | Caminho padrão |
| --- | --- |
| Migrations | `generated/migrations/<timestamp>__init.sql`, depois `<timestamp>__changes.sql`, mais `.snapshot.json` |
| Policies | `generated/policies/<table>_rls.sql` |
| Triggers | `generated/triggers/<table>_triggers.sql` |
| RPCs | `generated/rpcs/rpcs.sql` |
| SDK | `generated/sdk/types.ts` + `client.ts` (ou `output.sdk`) |

Cada execução informa cada arquivo como `created`, `updated` ou `unchanged`. Arquivos cuja única diferença é a linha `-- Generated at:` ficam intactos. `--output <dir>` coloca todas as pastas de saída dentro de `<dir>`, sobrepondo os caminhos da config: útil para pré-visualizar numa pasta de rascunho.

Tudo o que está listado acima é derivado: nunca edite à mão. O wrapper de client que o `init` escreveu (`index.ts`, ou `server.ts` + `browser.ts` no Next.js) é seu; o `generate` nunca mexe nele.

## Aplique no banco: `push` {#apply-to-the-database-push}

```bash
npx accessnexus push --dry-run
npx accessnexus push
npx accessnexus push --url "$SUPABASE_DB_URL"
```

O `push` é o único comando que altera o banco. Ele aplica os arquivos gerados nesta ordem: migrations, policies, triggers, RPCs, e registra cada um em `public.accessnexus_migrations` com um checksum. O push inteiro é uma única transação: se qualquer arquivo falhar (`PUSH_FAILED`), nada desse push fica aplicado, nem os registros de controle.

Antes de mexer em qualquer coisa, ele se recusa a continuar quando:

| Checagem | Código de erro |
| --- | --- |
| Nada foi gerado | `NOTHING_TO_PUSH` |
| O SQL gerado não bate mais com o schema (você esqueceu o `generate`) | `GENERATED_OUT_OF_DATE` |
| A role conectada não consegue ignorar o RLS, e o SQL contém helpers `SECURITY DEFINER` | `PUSH_ROLE_NO_BYPASSRLS` |
| Uma tabela que o schema gerencia tem policies de RLS que o AccessNexus não gerou (fora do padrão `<prefix>_<table>_<op>`); elas continuariam concedendo acesso | `FOREIGN_POLICIES` |
| Uma migration pendente remove uma tabela ou coluna, ou muda o tipo de uma coluna | `DESTRUCTIVE_MIGRATION` |

Nas execuções seguintes, arquivos inalterados são pulados, arquivos de policy, trigger e RPC alterados são reaplicados, e uma migration já aplicada que foi editada é recusada (`MIGRATION_DRIFT`). Se outro `push` estiver segurando o lock no mesmo banco, ele imprime um aviso e espera.

| Flag | Efeito |
| --- | --- |
| `--dry-run` | Lista os arquivos e todos os statements destrutivos nas migrations. Não precisa de URL de banco nem de driver; quando há URL, também ensaia o push numa transação desfeita e devolve o [plano contra o banco](#against-the-live-database-diff-against-db) (`livePlan`) e as policies e triggers estranhos. Nada persiste. Ainda recusa SQL desatualizado. |
| `--allow-destructive` | Aplica migrations que removem tabelas ou colunas ou mudam tipos de coluna. |
| `--replace-foreign-policies` | Remove as policies estranhas listadas pelo `FOREIGN_POLICIES`, dentro da transação do push. Só depois de revisá-las ([Projeto existente](/pt/guide/existing-project#the-safe-first-push)). |
| `--seed` | Depois de um push bem-sucedido, roda o seed. |
| `--allow-remote-seed` | Com `--seed`: permite um host Supabase hospedado. |
| `--url <db-url>` | URL do banco. `--db-url` é um alias (a flag que o `init` usa). |
| `--target <name>` | Usa um target de `config.targets`. |

::: danger `--allow-destructive` apaga dados
Só passe essa flag depois de ler os statements destrutivos no `push --dry-run`, com um backup e (se um agente estiver no controle) com a concordância explícita do usuário. Se a mudança era para ser uma renomeação, altere o schema.
:::

O `push` precisa do driver `pg` (`npm install -D pg`) e deve conectar com uma role que tenha `BYPASSRLS`. No Supabase, é o usuário `postgres` da connection string do **Session pooler** (Dashboard, Connect).

## Carregue dados de desenvolvimento: `seed` {#load-development-data-seed}

```bash
npx accessnexus seed --dry-run    # imprime o SQL
npx accessnexus seed
npx accessnexus push --seed       # push, depois seed
```

Seeds fazem upsert pela primary key, criam as linhas referenciadas em `auth.users` com senha aleatória e recusam hosts Supabase hospedados, a menos que `--allow-remote-seed`. Veja [Seed](/pt/guide/seed).

## Ajuda e versão {#help-and-version}

```bash
npx accessnexus help              # visão geral
npx accessnexus help push         # um comando (igual a: push --help)
npx accessnexus push --help --json
npx accessnexus version           # também: --version, -v
```

`help --json` e `<command> --help --json` retornam os comandos, suas flags e os exit codes num único objeto JSON, e é assim que um agente consegue descobrir a CLI sem fazer parsing de texto.

## Arquivo de config {#config-file}

O `accessnexus.config.ts` é opcional. Todo campo tem um padrão.

```ts [accessnexus.config.ts]
import { defineConfig } from 'accessnexus';

export default defineConfig({
  schema: './accessnexus.schema.ts',
  seed: './accessnexus.seed.ts',
  output: {
    dir: './generated',                 // base para as pastas abaixo
    migrations: './supabase/migrations',
    sdk: './src/lib/accessnexus',       // de onde o app importa o client
  },
  naming: { policyPrefix: 'app' },      // nomes das policies: <prefix>_<table>_<operation>
  generate: { sqlOnly: false, sdkOnly: false },
  adapterOptions: {
    dbUrlEnv: 'SUPABASE_DB_URL',        // variável de ambiente de onde push/seed leem a URL do banco
    deterministic: true,                // omite a linha de cabeçalho "Generated at"
  },
  targets: {                            // push/seed --target <name>
    staging: { adapter: 'supabase', adapterOptions: { dbUrlEnv: 'STAGING_DB_URL' } },
  },
});
```

| Campo | Padrão | Finalidade |
| --- | --- | --- |
| `schema` | `./accessnexus.schema.ts` | Arquivo de schema (`--schema` sobrepõe) |
| `seed` | `./accessnexus.seed.ts` | Arquivo de seed |
| `output.dir` | `./generated` | Pasta base; `migrations`, `policies`, `triggers`, `rpcs` e `sdk` podem ser definidos individualmente |
| `naming.policyPrefix` | `accessnexus` | Prefixo dos nomes gerados de policies, helpers e triggers |
| `generate.sqlOnly` / `sdkOnly` | `false` | Iguais às flags |
| `adapterOptions.dbUrlEnv` | nenhum | Nome da variável de ambiente com a URL do banco |
| `adapterOptions.deterministic` | `false` | Remove a linha `Generated at:` para a saída ficar estável byte a byte |
| `targets` | nenhum | Bancos nomeados para `push` / `seed --target <name>` |

### Targets {#targets}

Um target dá nome a outro banco. Cada target precisa de `adapter: 'supabase'` (senão, `TARGET_INVALID`) e normalmente do seu próprio `dbUrlEnv`:

```bash
STAGING_DB_URL=postgresql://... npx accessnexus push --target staging
```

::: warning Um target recorre às variáveis genéricas
Se a variável de ambiente do target não estiver definida, `push` e `seed` continuam procurando em `ACCESSNEXUS_DB_URL`, `SUPABASE_DB_URL` e `DATABASE_URL`. Um shell com `SUPABASE_DB_URL` apontando para outro banco vai fazer o push lá. Confira a URL mascarada na saída, ou passe `--url` explicitamente em scripts.
:::

## Variáveis de ambiente {#environment-variables}

`.env` e `.env.local` da pasta atual são carregados por todos os comandos. Uma variável já definida no ambiente tem prioridade sobre o arquivo.

| Variável | Usada por | Finalidade |
| --- | --- | --- |
| `ACCESSNEXUS_DB_URL`, `SUPABASE_DB_URL`, `DATABASE_URL` | `push`, `seed`, `init` | URL do banco, checadas nessa ordem depois de `--url` e `adapterOptions.dbUrlEnv` |
| o nome em `adapterOptions.dbUrlEnv` | `push`, `seed` | Variável de URL do banco específica do projeto |
| `ACCESSNEXUS_SEED_PASSWORD` | `seed`, `push --seed` | Senha das linhas de `auth.users` criadas pelo seed (só bancos locais) |
| `ACCESSNEXUS_DB_CONNECT_TIMEOUT` | `push`, `seed`, `init --db-url` | Segundos até `DB_CONNECTION_FAILED` (padrão 10) |
| `DEBUG=accessnexus` | todos | Igual a `--verbose` |
| `NO_COLOR` | todos | Desliga as cores |
| `NEXT_PUBLIC_SUPABASE_URL`, `VITE_SUPABASE_URL`, `REACT_APP_SUPABASE_URL`, `SUPABASE_URL` | `init` | URL do projeto para a importação via REST (só tabelas) |
| `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SECRET_KEY`, ... (ou qualquer valor `sb_secret_...`) | `init` | Secret key para a importação via REST |

No Supabase, use a connection string do **Session pooler**. Bancos locais podem precisar de `?sslmode=disable`.

## Rode no CI {#run-it-in-ci}

Duas checagens pegam a maioria dos erros antes do review: `validate` (o schema está correto) e `diff --check` (o SQL e o SDK commitados batem com o schema). Nenhuma das duas precisa de banco.

```yaml [.github/workflows/accessnexus.yml]
name: accessnexus

on:
  pull_request:
  push:
    branches: [main]

jobs:
  schema:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - name: Validate the schema
        run: npx accessnexus validate
      - name: Generated files are up to date
        run: npx accessnexus diff --check
```

Quando o segundo passo falha, o log mostra os trechos desatualizados. A correção é sempre local: rode `npx accessnexus generate` e faça commit do resultado.

::: tip SDK não commitado?
O `diff --check` também compara o SDK. Se a pasta do SDK está no gitignore e é gerada no build, cheque só o SQL: `npx accessnexus diff --check --sql-only`.
:::

::: details Deploy pelo CI
O `push` é seguro para automatizar: ele recusa sozinho SQL desatualizado e migrations que perdem dados. Adicione `pg` como dev dependency e guarde a URL do Session pooler como secret:

```yaml
      - name: Push to staging
        run: npx accessnexus push --json
        env:
          SUPABASE_DB_URL: ${{ secrets.STAGING_DB_URL }}
```

Uma migration destrutiva faz esse passo falhar com `DESTRUCTIVE_MIGRATION` e não aplica nada. Decida à mão, nunca adicionando `--allow-destructive` ao pipeline.
:::

## Veja também {#related}

- [Referência da CLI](/pt/api/cli): todas as flags e formatos de JSON
- [Códigos de erro](/pt/api/errors)
- [Solução de problemas](/pt/guide/troubleshooting)
- [Seed](/pt/guide/seed)
- [Projetos existentes](/pt/guide/existing-project)
- [Feito para agentes de IA](/pt/guide/ai-agents)
