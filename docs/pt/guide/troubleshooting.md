# Solução de problemas

Encontre seu problema pelo sintoma (o que o app ou o Postgres diz) ou pelo código de erro que a CLI imprimiu. Com `--json`, o código está em `error.code` e a correção em `error.hint`. Exit code `1` significa que você consegue corrigir; `2` é um bug do AccessNexus (rode de novo com `--verbose` e reporte o stack).

## Por sintoma {#by-symptom}

### "new row violates row-level security policy for table ..." {#new-row-violates-row-level-security-policy-for-table}

SQLSTATE `42501` do Postgres. A linha escrita não passa no `WITH CHECK` de uma policy de insert ou update.

| Causa provável | Correção |
| --- | --- |
| A coluna de owner não é quem chama (`user_id` faltando ou com o id de outra pessoa) | Envie `user_id: user.id`; `isOwner` e `definePermissions` fixam isso de propósito |
| Um update tira a linha da regra (muda o owner ou o tenant) | Intencional: o `UPDATE` mantém o `WITH CHECK`. Congele essas colunas com `trigger.lockColumns` |
| O insert mira um tenant do qual o usuário não é membro | Intencional (`pinTenant`). Confira se a linha de membership existe |
| **A regra de `select` não admite a linha nova** (veja a próxima seção) | Adicione um ramo que a admita |

Nunca corrija isso removendo policies, com `enableRLS: false` ou com `policy.public()` para escritas.

### `create()` ou `update()` falha mesmo com a escrita permitida {#create-or-update-fails-although-the-write-is-allowed}

O `create` e o `update` do SDK retornam a linha (`INSERT/UPDATE ... RETURNING`), e o Postgres checa a linha retornada contra a policy de `select`. Se o `select` não a admite, a escrita falha com o erro de RLS acima. Casos típicos:

- Uma tabela de membership cujo `select` é "membros da org": a linha nova do próprio usuário ainda não está visível. Adicione `policy.isOwner('user_id')` ao `select`.
- Uma tabela de tenant cuja primeira membership é adicionada por um trigger AFTER INSERT: o `RETURNING` é checado antes dele. Adicione `'own'` (ou `policy.isOwner('created_by')`) ao `read`.
- Um `select` de soft delete que exclui `deleted_at IS NOT NULL` não tem problema; mas um `select` com uma condição que a linha escrita não atende (por exemplo, só `published = true`) tem.

### Leituras não retornam nada, ou `findById` / `update` retornam "no rows" {#reads-return-nothing-or-findbyid-update-return-no-rows}

O RLS esconde linhas em vez de lançar erros. Um `SELECT` retorna `[]`, um `DELETE` afeta 0 linhas, e o `findById` / `update` do SDK (que usam `.single()`) retornam o erro `PGRST116` do PostgREST.

- A tabela não tem `policies` (deny-all, `NO_POLICIES`), ou não tem regra para aquela operação.
- A requisição é anônima: a sessão expirou, ou o client foi criado sem a sessão do usuário.
- A regra checa uma coluna diferente da que você imagina: rode o `validate` (`UNKNOWN_COLUMN` no modo manual não é pego pelo TypeScript).

### "permission denied for function ..." {#permission-denied-for-function}

Uma RPC `security: 'definer'` chamada por um visitante anônimo. O EXECUTE é revogado de `anon` por design. Faça login antes, ou adicione `allowAnon: true` se o uso anônimo for intencional (e cheque quem chama no corpo).

### "stack depth limit exceeded" ou "infinite recursion detected in policy" {#stack-depth-limit-exceeded-or-infinite-recursion-detected-in-policy}

- O SQL foi aplicado por uma role sem `BYPASSRLS`, então os helpers de membership reentram na própria policy. O `push` agora recusa isso (`PUSH_ROLE_NO_BYPASSRLS`); faça o push de novo como `postgres`.
- Uma subquery em `policy.custom` lê a mesma tabela em que a policy está. Use `policy.belongsTo` com uma tabela de membership, que compila para um helper seguro contra recursão.

### Erros de coluna travada ou de soft delete (SQLSTATE 42501) {#locked-column-or-soft-delete-errors-sqlstate-42501}

- `trigger.lockColumns` lançou o erro: o usuário tentou mudar uma coluna congelada. Intencional; mude-a pela service role ou por uma RPC definer.
- "`<table>.<column>` can only be set by DELETE (soft delete)": um `UPDATE` comum mexeu na coluna de soft delete. Apague a linha em vez disso; restaure por uma RPC definer.

### Erro de foreign key ao apagar um pai {#foreign-key-error-when-deleting-a-parent}

Foreign keys usam `ON DELETE NO ACTION` por padrão. Defina `onDelete: { column: 'cascade' | 'set null' | 'restrict' }`.

### As policies parecem permitir mais do que o schema diz {#policies-seem-to-allow-more-than-the-schema-says}

- Policies antigas criadas fora do AccessNexus (dashboard, migrations anteriores) ainda existem, e o Postgres combina policies permissivas com OR. Liste-as: `SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public';`

### Drift: o banco não bate mais com o schema {#drift-the-database-no-longer-matches-the-schema}

- `MIGRATION_DRIFT`: um arquivo de migration já aplicado foi editado. Restaure-o (`git checkout -- <file>`), altere o schema e rode o `generate` para criar uma nova migration `__changes`.
- Mudanças feitas no dashboard não são detectadas pelo `diff`, que compara o schema com os arquivos em disco, não com o banco. Traga-as para o schema, ou desfaça-as.

## Por código de erro da CLI {#by-cli-error-code}

### Schema e config {#schema-and-config}

| Código | Correção |
| --- | --- |
| `SCHEMA_NOT_FOUND` | Crie `accessnexus.schema.ts` (`init --yes`), passe `--schema` ou defina `schema` na config |
| `SCHEMA_NO_DEFAULT_EXPORT` | Termine o arquivo com `export default defineSchema({...})` |
| `SCHEMA_INVALID` | Um builder rejeitou a definição (identificador inválido, referência desconhecida, role desconhecida); a mensagem diz qual |
| `SCHEMA_VALIDATION_FAILED` | Corrija cada entrada de `issues[]` (veja abaixo) |
| `SCHEMA_LOAD_FAILED`, `CONFIG_LOAD_FAILED`, `SEED_LOAD_FAILED` | O arquivo lançou um erro ou importa um pacote que não existe |
| `MODULE_SYNTAX_ERROR` | Erro de sintaxe no local indicado |
| `TS_LOADER_MISSING` | Falta o esbuild: `npm install -D accessnexus` |
| `CONFIG_NOT_FOUND`, `CONFIG_INVALID` | Corrija `--config` ou o export default da config |
| `UNKNOWN_COMMAND`, `UNKNOWN_FLAG`, `MISSING_FLAG_VALUE`, `INVALID_FLAG_VALUE`, `UNEXPECTED_ARGUMENT`, `INVALID_FLAGS` | Siga o hint ou o `--help` |

### Generate, diff e push {#generate-diff-and-push}

| Código | Correção |
| --- | --- |
| `GENERATED_OUT_OF_DATE` | Rode o `diff` para revisar, depois o `generate`, e tente de novo |
| `NOTHING_TO_PUSH` | Rode o `generate` antes (ou corrija o `--output`) |
| `DESTRUCTIVE_MIGRATION` | Nada foi aplicado. Uma renomeação deve ser uma renomeação no schema; caso contrário, confirme a perda de dados (com backup) e passe `--allow-destructive` |
| `DB_URL_MISSING` | Passe `--url` ou defina `SUPABASE_DB_URL` / `ACCESSNEXUS_DB_URL` / `DATABASE_URL` |
| `PG_DRIVER_MISSING` | `npm install -D pg` |
| `DB_CONNECTION_FAILED` | URL, senha ou rede errada. Use a string do Session pooler; bancos locais podem precisar de `?sslmode=disable`; timeout via `ACCESSNEXUS_DB_CONNECT_TIMEOUT` |
| `PUSH_ROLE_NO_BYPASSRLS` | Nada foi aplicado. Conecte como `postgres`, ou rode `ALTER ROLE <role> BYPASSRLS` como superuser |
| `PUSH_FAILED` | O Postgres rejeitou um arquivo (mensagem incluída). Esse arquivo sofreu rollback; os arquivos em `applied` continuam. Corrija o schema, rode o `generate` e faça o push de novo |
| `MIGRATION_DRIFT` | Restaure a migration aplicada, altere o schema, rode o `generate` |
| `ADAPTER_NOT_FOUND`, `ADAPTER_AMBIGUOUS`, `ADAPTER_UNSUPPORTED`, `TARGET_NOT_FOUND` | Só existe o adapter `supabase` |
| `TARGET_INVALID` | Adicione `adapter: 'supabase'` ao target |

::: tip `GENERATED_OUT_OF_DATE` que o `generate` não resolve
Se o `diff` lista um arquivo como **removido** (`D`), por exemplo `generated/triggers/<table>_triggers.sql` depois que você tirou o último trigger de uma tabela, o `generate` não o apaga na v0.1.0. Apague esse arquivo à mão e o `diff --check` passa. O trigger ou a função em si continua no banco até você removê-lo.
:::

Um `PUSH_FAILED` em `rpcs.sql` dizendo "cannot change return type of existing function" significa que você mudou o `returns` de uma RPC: remova a função antiga como `postgres` e faça o push.

### Seed e init {#seed-and-init}

| Código | Correção |
| --- | --- |
| `SEED_NOT_FOUND`, `SEED_EMPTY` | Crie ou corrija o `accessnexus.seed.ts` |
| `SEED_FAILED` | Sofreu rollback. Faça o push antes; confira colunas e chaves únicas (inclusive linhas que um trigger já cria) |
| `SEED_REMOTE_BLOCKED` | Use um banco local, ou `--allow-remote-seed` para um descartável |
| `INIT_NOT_INTERACTIVE` | Adicione `--yes` |
| `INIT_NEEDS_INPUT` | Passe a flag indicada no hint |
| `INIT_DETECT_FAILED` | Rode na raiz do projeto, ou deixe o `init --yes` criar um `package.json` |
| `INTERNAL_ERROR` (exit 2) | Bug do AccessNexus: rode de novo com `--verbose` e reporte o stack |

## Problemas de validação do schema {#schema-validation-issues}

Erros fazem o `validate` falhar; warnings devem ser corrigidos, a menos que a escolha seja deliberada.

| Código | Correção |
| --- | --- |
| `UNKNOWN_COLUMN`, `UNKNOWN_TABLE` | Corrija o nome na policy, trigger, referência ou índice |
| `UNKNOWN_COLUMN_TYPE` | Use um tipo suportado (`uuid`, `text`, `int`, `jsonb`, `timestamptz`, `"enum('a','b')"`, ...) |
| `OWNER_COLUMN_NOT_UUID` | `isOwner` precisa de uma coluna `uuid` |
| `INVALID_POLICY_RULE` | Use `policy.public()`, não a string `'public'` |
| `UNKNOWN_POLICY_OPERATION` | As chaves são `select`/`insert`/`update`/`delete`, não `read`/`create` |
| `EMPTY_COMBINATOR` | `policy.any([])` / `policy.all([])` precisa de regras |
| `MISSING_COLUMNS` | Adicione `columns` (modo manual) |
| `AUDIT_TABLE_MISMATCH` | Dê à tabela de auditoria `table_name`, `operation`, `old_data`, `new_data`, `changed_at` |
| `RPC_IN_TABLES` | Mova as RPCs para `defineSchema(tables, { rpcs })` |
| `INVALID_TRIGGER`, `INVALID_REFERENCE` | Corrija o trigger ou a referência `'table.column'` |
| `INVALID_IDENTIFIER`, `RESERVED_IDENTIFIER` | snake_case minúsculo, sem palavras reservadas (`order` → `orders`) |
| `UNKNOWN_TABLE_KEY` | Um erro de digitação (`polices:`) ou tabelas aninhadas em `tables:` |
| `INVALID_ENUM_VALUE` | Um valor de `where` do `belongsTo` que não está no enum (role digitada errado) |
| `INVALID_DEFAULT` | `default` é SQL cru: `"'todo'"`, não `'todo'` |
| `INVALID_ON_DELETE` | Ação desconhecida, sem foreign key, ou `'set null'` numa coluna NOT NULL |
| `CASCADE_INTO_SOFT_DELETE` | Use `'restrict'` |
| `DUPLICATE_TRIGGER` | Dê ao segundo trigger `lockColumns`/`custom` o seu próprio `name` |
| `BELONGS_TO_PROFILE_WRITABLE` | Use uma tabela de membership, ou deixe a coluna do profile ser escrita só pelo servidor |
| `RLS_DISABLED_WITH_POLICIES` | Remova o `enableRLS: false` |
| `NO_POLICIES` (warning) | Adicione policies se o client usa a tabela |
| `RLS_DISABLED` (warning) | Remova o `enableRLS: false`, a menos que a tabela precise ficar aberta |
| `TENANT_PARENT_UNCHECKED` (warning) | Adicione o [guard de mesmo tenant](/pt/guide/cookbook#child-of-a-tenant-resource) |
| `NO_PRIMARY_KEY` (warning) | Adicione `primaryKey` |
| `UNWRAPPED_AUTH_CALL` (warning) | Escreva `(SELECT auth.uid())` |
| `PUBLIC_WRITE` (warning) | Escritas abertas a visitantes anônimos; use uma regra de owner ou de tenant |
| `USER_ROW_INSERT_OPEN` (warning) | Use `policy.isOwner('id')` |
| `AUDIT_INSERT_OPEN` (warning) | Defina o `insert` da tabela de auditoria como `policy.none()` |
| `GLOBAL_ROLE_IN_TENANT_TABLE` (warning) | Use uma role de tenant em vez de `hasRole` |
| `SCHEMA_EMPTY` (warning) | Adicione tabelas |

## Veja também {#related}

- [Referência de códigos de erro](/pt/api/errors)
- [CLI](/pt/guide/cli)
- [Modelo de segurança](/pt/guide/security)
- [Cookbook](/pt/guide/cookbook)
