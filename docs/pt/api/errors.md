# Erros {#errors}

Todos os error codes da CLI e todos os códigos de issue do schema, gerados a partir do código-fonte (códigos de `CliError` em `src/cli/**`, códigos de issue em `src/cli/schema-check.ts`). Passo a passo: [Solução de problemas](/pt/guide/troubleshooting).

Existem dois tipos:

- **Erros da CLI** interrompem o comando. Têm um `code` estável, uma `message` e, geralmente, um `hint`; no modo `--json` ficam em `error`. Exit code `1`, salvo indicação contrária.
- **Issues de schema** são encontradas pelas verificações estáticas que `validate`, `generate`, `diff` e `push` rodam antes de produzir SQL. Cada uma tem `severity`, `code`, `path` (ex.: `posts.policies.update`), `message` e, geralmente, `hint`. Qualquer issue com severidade `error` faz o comando falhar com `SCHEMA_VALIDATION_FAILED` e a lista completa em `issues`.

```ts
interface SchemaIssue {
  severity: 'error' | 'warning';
  code: string;
  path: string;
  message: string;
  hint?: string;
}
```

## Erros da CLI {#cli-errors}

### Uso {#usage}

| Código | Comandos | Significado | Correção |
| --- | --- | --- | --- |
| `UNKNOWN_COMMAND` | qualquer | O primeiro argumento não é um comando. | Use o comando sugerido; `accessnexus help` lista todos. |
| `UNKNOWN_FLAG` | qualquer | A flag não é aceita por este comando. | Use a flag sugerida; `<command> --help` lista todas. |
| `UNEXPECTED_ARGUMENT` | qualquer | Foi passado um argumento posicional; os comandos só aceitam flags. | Prefixe com `--` ou remova. |
| `MISSING_FLAG_VALUE` | qualquer | Uma flag de string está sem valor (fim da entrada, ou o próximo token começa com `--`). | `--flag value` ou `--flag=value`. |
| `INVALID_FLAG_VALUE` | qualquer | Uma flag booleana recebeu um valor (`--json=true`). | Passe a flag sozinha. |
| `INVALID_FLAGS` | `generate`, `diff`, `push`, `seed` | `--sql-only` junto com `--sdk-only`, ou `--target` cujo adapter difere de `--adapter`. | Passe no máximo uma do par; passe só `--target`. |

### Config e carregamento de arquivos {#config-and-file-loading}

| Código | Comandos | Significado | Correção |
| --- | --- | --- | --- |
| `CONFIG_NOT_FOUND` | todos exceto `init` | `--config <path>` não existe. | Corrija o caminho ou remova `--config`. |
| `CONFIG_INVALID` | todos exceto `init` | O arquivo de config não exporta um objeto. | `export default defineConfig({ ... })`. |
| `CONFIG_LOAD_FAILED` | todos exceto `init` | A config lançou um erro ao rodar, ou importa um módulo que não foi encontrado. | Corrija o import ou o erro indicado; instale o pacote que falta. |
| `SCHEMA_NOT_FOUND` | `validate`, `generate`, `diff`, `push`, `seed` | Não há arquivo de schema no caminho resolvido. | `accessnexus init --yes`, `--schema <path>` ou `schema` na config. |
| `SCHEMA_NO_DEFAULT_EXPORT` | idem | O arquivo de schema não tem default export. | Termine com `export default defineSchema({ ... })`. |
| `SCHEMA_LOAD_FAILED` | idem | O schema lançou um erro ao rodar, ou importa um módulo que não foi encontrado. | Corrija o import ou o erro indicado. |
| `SCHEMA_INVALID` | idem | Um builder lançou erro: `defineSchema` (identificador inválido, primary key ou coluna de referência desconhecida, referência inválida ou pendente) ou `definePermissions` (role desconhecida, escopo de tenant sem config de tenant, resource desconhecido, `ownerColumn` / `tenantColumn` / `roleColumn` ausente). | Corrija a definição indicada na mensagem. Veja [erros do definePermissions](/pt/api/permissions#errors). |
| `SCHEMA_VALIDATION_FAILED` | idem | As verificações estáticas encontraram pelo menos uma issue com severidade `error`. | Corrija cada item de `issues` no seu `path`, como o `hint` indica. Veja [Issues de schema](#schema-issues). |
| `SEED_LOAD_FAILED` | `seed`, `push --seed` | O arquivo de seed lançou um erro ao rodar, ou importa um módulo que não foi encontrado. | Corrija o import ou o erro indicado. |
| `MODULE_SYNTAX_ERROR` | qualquer um que carregue arquivo | O arquivo de config, schema ou seed não compila; a mensagem traz `file:line:column`. | Corrija o erro de sintaxe ou de TypeScript. |
| `TS_LOADER_MISSING` | qualquer um que carregue arquivo | O esbuild não está disponível e o Node não consegue carregar o arquivo TypeScript nativamente. | Reinstale (`npm install -D accessnexus`) ou use Node.js >= 22.18. |

### Saída gerada {#generated-output}

| Código | Comandos | Significado | Correção |
| --- | --- | --- | --- |
| `GENERATED_OUT_OF_DATE` | `diff --check`, `push` | Os arquivos gerados diferem do que o schema produz. O JSON mantém o diff (`diff`) ou `stale` (`push`). | Revise o `accessnexus diff`, rode `accessnexus generate` e tente de novo. |
| `NOTHING_TO_PUSH` | `push` | Não há arquivos `.sql` nas pastas de saída. | Rode `generate` antes, ou aponte `--output` / a config para a pasta gerada. |

### Banco de dados e push {#database-and-push}

| Código | Comandos | Significado | Correção |
| --- | --- | --- | --- |
| `DB_URL_MISSING` | `push`, `seed` | Nenhuma URL de banco vinda de `--url`, `dbUrlEnv`, `ACCESSNEXUS_DB_URL`, `SUPABASE_DB_URL` ou `DATABASE_URL`. | Passe `--url` ou defina uma delas (shell, `.env`, `.env.local`). Use `--dry-run` para ver a prévia sem banco. |
| `PG_DRIVER_MISSING` | `push`, `seed`, `init --db-url` | A peer dependency opcional `pg` não está instalada (ou não exporta `Client`). | `npm install -D pg`. |
| `DB_CONNECTION_FAILED` | `push`, `seed`, `init --db-url` | A conexão falhou ou estourou o tempo (10 s por padrão). | Confira URL, senha e rede. Supabase: string do "Session pooler". Local: `?sslmode=disable`. Timeout: `ACCESSNEXUS_DB_CONNECT_TIMEOUT=<seconds>`. |
| `PUSH_ROLE_NO_BYPASSRLS` | `push` | O SQL contém helpers `SECURITY DEFINER`, mas a role conectada não ignora o RLS. Nada foi aplicado. | Conecte como `postgres`, ou rode `ALTER ROLE <role> BYPASSRLS` como superuser. |
| `DESTRUCTIVE_MIGRATION` | `push` | Uma migration pendente remove tabela, coluna ou tipo, faz truncate ou muda o tipo de uma coluna. Nada foi aplicado; `destructive` lista os statements. | Se for um rename: renomeie no schema. Se a perda for intencional: faça backup e rode `push --allow-destructive`. |
| `MIGRATION_DRIFT` | `push` | Um arquivo de migration já aplicado foi editado. | Restaure o arquivo, altere o schema e rode `generate` para gerar uma nova migration `__changes`. |
| `PUSH_FAILED` | `push` | O Postgres rejeitou um arquivo (a mensagem traz o erro SQL). Esse arquivo sofreu rollback; os arquivos em `applied` continuam aplicados. | Corrija a causa no schema (ou no estado do banco), rode `generate` e `push` de novo. |

### Adapter e target {#adapter-and-target}

| Código | Comandos | Significado | Correção |
| --- | --- | --- | --- |
| `ADAPTER_NOT_FOUND` | `push`, `seed` | `--adapter <name>` não corresponde a nenhum adapter configurado. | Use um dos listados no hint. |
| `ADAPTER_AMBIGUOUS` | `push`, `seed` | `config.adapters` lista vários adapters e nenhum foi escolhido. | Passe `--adapter` ou `--target`. |
| `ADAPTER_UNSUPPORTED` | `push`, `seed` | O adapter selecionado não é `supabase`. | `adapter: 'supabase'`. |
| `TARGET_NOT_FOUND` | `push`, `seed` | `--target <name>` não está em `config.targets`. | Use um target listado ou defina-o. |
| `TARGET_INVALID` | `push`, `seed` | O target não tem a string `adapter`. | Adicione `adapter: 'supabase'` a ele. |

### Seed

| Código | Comandos | Significado | Correção |
| --- | --- | --- | --- |
| `SEED_NOT_FOUND` | `seed`, `push --seed` | O arquivo de seed não existe. Com `push --seed`, o SQL já foi aplicado. | Crie `accessnexus.seed.ts`, passe `--seed <path>` ou defina `seed` na config. |
| `SEED_EMPTY` | `seed`, `push --seed` | O default export do arquivo de seed não é um objeto ou não tem tabelas. | `export default defineSeed(schema, { table: [rows] })`. |
| `SEED_REMOTE_BLOCKED` | `seed`, `push --seed` | A URL é de um banco Supabase hospedado (`*.supabase.co`, `.com`, `.in`). | Use um banco local, ou `--allow-remote-seed` para um projeto descartável. |
| `SEED_FAILED` | `seed`, `push --seed` | O Postgres rejeitou o seed; ele sofreu rollback. | Rode `push` antes; faça as linhas baterem com o schema (chaves únicas, referências). |

Com `push --seed`, qualquer erro de seed mantém o próprio código, a mensagem ganha o prefixo `Push succeeded, but the seed failed:` e o JSON traz `seed.status: 'failed'`.

### init

| Código | Significado | Correção |
| --- | --- | --- |
| `INIT_NOT_INTERACTIVE` | O `init` faria uma pergunta, mas o stdin não é um TTY (ou `--json` está ativo). | Adicione `--yes`. |
| `INIT_NEEDS_INPUT` | Uma pergunta ficou sem resposta no modo não interativo. | Passe a flag indicada no hint. |
| `INIT_DETECT_FAILED` | Não foi possível detectar o projeto (geralmente falta o `package.json`). | Rode na raiz do projeto, `npm init -y`, ou `init --yes` (cria um `package.json` mínimo). |

### Interno {#internal}

| Código | Exit | Significado | Correção |
| --- | --- | --- | --- |
| `INTERNAL_ERROR` | `2` | Qualquer exceção inesperada: um bug do AccessNexus. | Rode de novo com `--verbose` (ou `DEBUG=accessnexus`) e reporte o stack trace. |

## Issues de schema {#schema-issues}

Verificações estáticas rodadas por `validate`, `generate`, `diff` e `push`. No Database mode, as verificações que precisam da lista de colunas são puladas, e `UNKNOWN_TABLE` vira warning em vez de erro.

### Estrutura do schema {#schema-structure}

| Código | Severidade | Path | Significado | Correção |
| --- | --- | --- | --- | --- |
| `SCHEMA_NOT_AN_OBJECT` | error | `(default export)` | O default export não é um objeto. | `export default defineSchema({ ... })`. |
| `SCHEMA_EMPTY` | warning | `(schema)` | O schema não tem tabelas. | Adicione tabelas. |
| `INVALID_TABLE` | error | `<table>` | Uma entrada de tabela não é um objeto. | `<table>: table({ ... })`. |
| `RPC_IN_TABLES` | error | `<table>` | Um `rpc()` foi colocado no meio das tabelas. | Passe-o em `defineSchema(tables, { rpcs: { ... } })`. |
| `UNKNOWN_TABLE_KEY` | error | `<table>.<key>` | Opção de tabela desconhecida (seria ignorada, ex.: `polices`), ou tabelas aninhadas sob uma chave como `tables:`. | Use a opção sugerida; válidas: `columns`, `primaryKey`, `references`, `onDelete`, `policies`, `triggers`, `enableRLS`, `indexes`, `softDelete`. |
| `MISSING_COLUMNS` | error | `<table>.columns` | Algumas tabelas declaram `columns` e esta não. | Declare colunas em todas as tabelas (manual) ou em nenhuma (Database mode). |

### Identificadores {#identifiers}

| Código | Severidade | Path | Significado | Correção |
| --- | --- | --- | --- | --- |
| `INVALID_IDENTIFIER` | error | tabela, coluna, `rpcs.<name>` ou trigger | Uma tabela, coluna, RPC, `name` de `lockColumns` ou `name` de trigger `custom` não está em snake_case minúsculo. | Renomeie, ex.: `user_profiles`. |
| `RESERVED_IDENTIFIER` | error | tabela ou coluna | Um nome de tabela ou coluna é palavra reservada do SQL (`order`, `user`, `group`, ...). Os identificadores são emitidos sem aspas. | Renomeie, ex.: `orders`, `user_id`. |

### Colunas {#columns}

| Código | Severidade | Path | Significado | Correção |
| --- | --- | --- | --- | --- |
| `INVALID_COLUMN` | error | `<table>.columns.<col>` | Uma coluna não é nem uma string de tipo nem `{ type, ... }`. | `email: 'text'` ou `email: { type: 'text', unique: true }`. |
| `UNKNOWN_COLUMN_TYPE` | error | `<table>.columns.<col>`, `rpcs.<name>.args.<arg>` | Tipo de coluna ou de argumento de RPC desconhecido. | Use um [tipo suportado](/pt/api/schema#column-types); o hint sugere um para aliases comuns. |
| `INVALID_DEFAULT` | error | `<table>.columns.<col>.default` | O `default` é uma palavra solta que o Postgres leria como nome de coluna, ou um default de enum que não é um dos valores. | Coloque aspas nos literais dentro da string: `default: "'todo'"`; funções como estão: `'now()'`. |
| `NO_PRIMARY_KEY` | warning | `<table>.primaryKey` | A tabela não tem `primaryKey`. | `primaryKey: 'id'` (necessário para `findById`, update/delete por id, soft delete, upserts do seed). |
| `UNKNOWN_COLUMN` | error | onde a coluna é usada | Uma coluna citada em `primaryKey`, `references`, `onDelete`, `softDelete`, `indexes`, numa regra de policy (`isOwner`, `belongsTo` e suas chaves `through` e `where`, `matchesField`) ou num trigger (`updatedAt`, `softDelete`, `auditLog.columns`, `lockColumns`) não existe. | Use uma coluna listada ou adicione-a em `columns`. |

### Chaves e referências {#keys-and-references}

| Código | Severidade | Path | Significado | Correção |
| --- | --- | --- | --- | --- |
| `INVALID_REFERENCE` | error | `<table>.references.<col>` | Não está no formato `table.column` nem `schema.table.column`. | `'profiles.id'`, `'auth.users.id'`. |
| `UNKNOWN_TABLE` | error (manual), warning (Database) | path de referência, policy ou trigger | Uma referência, um `through.table` de `belongsTo`, um `belongsTo` sem `through` (precisa de `profiles`) ou um destino de `auditLog` cita uma tabela que não está no schema. | Defina a tabela, corrija a grafia ou use `schema.table.column` para tabelas fora de `public`. |
| `INVALID_ON_DELETE` | error | `<table>.columns.<col>` ou `<table>.onDelete.<col>` | Ação desconhecida, `onDelete` numa coluna sem `references`, ou `'set null'` numa coluna `NOT NULL`. | Use `'cascade' \| 'set null' \| 'restrict' \| 'no action'`; adicione `references`; torne a coluna nullable. |
| `CASCADE_INTO_SOFT_DELETE` | error | `<table>.onDelete.<col>` | `onDelete: 'cascade'` numa tabela com soft delete: os filhos continuariam apontando para um pai excluído. | `'restrict'` (faça soft delete dos filhos antes), `'set null'`, ou remova `softDelete`. |

### RLS e policies {#rls-and-policies}

| Código | Severidade | Path | Significado | Correção |
| --- | --- | --- | --- | --- |
| `NO_POLICIES` | warning | `<table>.policies` | Sem policies: o RLS está ligado, então a API (anônimo e logado) não consegue ler nem gravar a tabela. | Adicione policies se o client usa a tabela; mantenha assim para tabelas só de servidor (ou `policy.none()` por operação). |
| `RLS_DISABLED` | warning | `<table>.enableRLS` | `enableRLS: false`: qualquer um com a anon key consegue ler e gravar a tabela. | Remova `enableRLS: false` e adicione policies. |
| `RLS_DISABLED_WITH_POLICIES` | error | `<table>.enableRLS` | `enableRLS: false` junto com `policies`. | Remova `enableRLS: false`. |
| `INVALID_POLICIES` | error | `<table>.policies` | `policies` não é um objeto. | `{ select: policy.isAuthenticated() }`. |
| `UNKNOWN_POLICY_OPERATION` | error | `<table>.policies.<op>` | A chave não é `select`, `insert`, `update` nem `delete` (ex.: `read`, `create`). | Use os nomes das operações SQL; `read`/`create` pertencem ao `definePermissions`. |
| `INVALID_POLICY_RULE` | error | `<table>.policies.<op>` | Não foi construída com `policy.*` (ex.: `'public'`), `hasRole` sem role, ou `custom` com expressão vazia. | `policy.public()`, `policy.hasRole('admin')`, uma expressão SQL não vazia. |
| `UNKNOWN_POLICY_KIND` | error | `<table>.policies.<op>` | Um objeto de regra tem um `kind` desconhecido. | Construa as regras com `policy.*`. |
| `EMPTY_COMBINATOR` | error | `<table>.policies.<op>` | `policy.any([])` ou `policy.all([])`. | Passe pelo menos uma regra, ou use `policy.none()`. |
| `OWNER_COLUMN_NOT_UUID` | error | `<table>.policies.<op>` | `policy.isOwner(col)` numa coluna que não é `uuid`. | Torne a coluna `uuid`. |
| `INVALID_ENUM_VALUE` | error | `<table>.policies.<op>` | Um valor de `through.where` do `belongsTo` não é valor daquela coluna enum (ex.: uma role com erro de digitação). | Use um dos valores listados. |

### Avisos e erros de segurança {#security-warnings-and-errors}

| Código | Severidade | Path | Significado | Correção |
| --- | --- | --- | --- | --- |
| `PUBLIC_WRITE` | warning | `<table>.policies.<insert\|update\|delete>` | `policy.public()` deixa visitantes anônimos gravarem. | `isAuthenticated()`, `isOwner(col)`, uma regra de tenant ou `policy.none()`. Mantenha `public()` só para um formulário anônimo intencional, combinado com uma verificação. |
| `USER_ROW_INSERT_OPEN` | warning | `<table>.policies.insert` | A primary key referencia `auth.users.id`, mas o `insert` é `isAuthenticated()` ou `public()`: qualquer um consegue criar a linha de outro usuário. | `insert: policy.isOwner('<pk>')`. |
| `GLOBAL_ROLE_IN_TENANT_TABLE` | warning | `<table>.policies.<op>` | A tabela verifica membership do tenant, mas também usa uma role global da aplicação (`hasRole` ou um array de roles). | Para roles de org/time, use `{ scope: 'tenant', roles }` ou `belongsTo(..., { where: { role } })`. |
| `TENANT_PARENT_UNCHECKED` | warning | `<table>.references.<col>` | Uma linha com escopo de tenant referencia outra tabela com escopo de tenant e nenhum trigger custom verifica se as duas estão no mesmo tenant (foreign keys ignoram o RLS). | Adicione o `trigger.custom` de guarda de mesmo tenant indicado no hint, e `trigger.lockColumns` nas duas colunas. |
| `BELONGS_TO_PROFILE_WRITABLE` | error | `<table>.policies.<op>` | `belongsTo(col)` sem `through` confia em `profiles.<col>`, mas os usuários conseguem inserir profiles ou atualizar essa coluna (ou profiles está com RLS desligado). | Use `through` (tabela de membership), ou faça `profiles.<col>` ser gravada só pelo servidor: `insert: policy.none()` e `trigger.lockColumns({ columns: ['<col>'] })`. |
| `UNWRAPPED_AUTH_CALL` | warning | policy, trigger `lockColumns` ou `rpcs.<name>.body` | Um `auth.uid()`, `auth.jwt()` ou `auth.role()` sem wrapper em `policy.custom`, num `unless` de `lockColumns` ou no body de uma RPC é reavaliado a cada linha. | Escreva `(SELECT auth.uid())`. |

### Triggers

| Código | Severidade | Path | Significado | Correção |
| --- | --- | --- | --- | --- |
| `INVALID_TRIGGERS` | error | `<table>.triggers` | `triggers` não é um array. | `triggers: [trigger.updatedAt('updated_at')]`. |
| `INVALID_TRIGGER` | error | `<table>.triggers[<i>]` | Não foi construído com `trigger.*`; kind desconhecido; `lockColumns` sem exatamente um de `columns` / `except`; `custom` sem eventos, com evento desconhecido, `functionBody` vazio ou `security` diferente de `'invoker'`/`'definer'`. | Corrija a opção indicada na mensagem. |
| `DUPLICATE_TRIGGER` | error | `<table>.triggers[<i>]` | Dois triggers geram o mesmo nome na mesma tabela e substituiriam um ao outro. | Dê a cada `lockColumns` / `custom` um `name` distinto; não adicione `trigger.softDelete` quando a tabela define `softDelete`. |
| `AUDIT_TABLE_MISMATCH` | error | `<table>.triggers[<i>]` | A tabela de auditoria não tem `table_name`, `operation`, `old_data`, `new_data`, `changed_at`, ou tem colunas obrigatórias que o trigger nunca preenche. | Adicione essas colunas; torne as outras nullable ou dê um default a elas. |
| `AUDIT_INSERT_OPEN` | warning | `<audit>.policies.insert` | A tabela de auditoria deixa usuários da API inserirem (entradas forjadas). O trigger não precisa disso. | `insert: policy.none()`. |

### RPCs

| Código | Severidade | Path | Significado | Correção |
| --- | --- | --- | --- | --- |
| `INVALID_RPC` | error | `rpcs.<name>` | Uma entrada de `rpcs` não foi criada com `rpc()`. | `rpcs: { name: rpc({ ... }) }`. |

As RPCs também produzem `INVALID_IDENTIFIER` (nome), `UNKNOWN_COLUMN_TYPE` (tipo de argumento) e `UNWRAPPED_AUTH_CALL` (body).
