# Modelo de segurança

O Supabase expõe suas tabelas via HTTP para qualquer um que tenha a anon key do projeto, e essa key vai dentro de todo bundle do browser. O Row-Level Security é a única coisa entre essa key e seus dados. O AccessNexus existe para tornar o RLS gerado correto por construção, e para apontar as escolhas de schema que o tornariam errado.

Esta página lista o que o gerador garante, as regras que você (ou seu agente) não pode quebrar, o que o `validate` checa e o que está fora do alcance do AccessNexus.

## O que o gerador garante {#what-the-generator-guarantees}

Isto vale para todo schema, sem opção de desligar (exceto `enableRLS: false`, abaixo).

### O RLS é habilitado e forçado em toda tabela {#rls-is-enabled-and-forced-on-every-table}

```sql
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes FORCE ROW LEVEL SECURITY;
```

O `FORCE` aplica as policies também ao dono da tabela, então só roles com `BYPASSRLS` (no Supabase: `postgres`, a service role) passam por cima delas.

### Sem policy, sem acesso {#no-policy-means-no-access}

O AccessNexus é fail-closed:

- Uma tabela sem `policies` é deny-all para a API: `anon` e `authenticated` não recebem nada. Só a service role e código `SECURITY DEFINER` chegam a ela. O `validate` avisa `NO_POLICIES`.
- Quando uma tabela tem `policies`, uma operação sem regra é negada. `{ select: policy.isOwner('user_id') }` permite ler as suas linhas e nenhuma escrita.
- O único jeito de abrir uma tabela é um `enableRLS: false` explícito, que o `validate` reporta como `RLS_DISABLED`.

### Chamadas de auth são avaliadas uma vez por query {#auth-calls-are-evaluated-once-per-query}

Todo builder emite `(SELECT auth.uid())` e `(SELECT auth.jwt())`, nunca a chamada direta. O Postgres transforma a subquery num initPlan e a avalia uma vez por statement em vez de uma vez por linha, o que em tabelas grandes é a diferença entre milissegundos e segundos.

```sql
USING ((SELECT auth.uid()) = user_id)
```

O SQL cru que você mesmo escreve (`policy.custom`, corpos de RPC, `lockColumns({ unless })`) é emitido como está. O `validate` avisa `UNWRAPPED_AUTH_CALL` quando encontra ali uma chamada sem o wrapper.

### Leituras e escritas são checadas separadamente {#reads-and-writes-are-checked-separately}

| Operação | Cláusula gerada | Significado |
| --- | --- | --- |
| `select` | `USING (rule)` | quais linhas são visíveis |
| `delete` | `USING (rule)` | quais linhas podem ser apagadas |
| `insert` | `WITH CHECK (rule)` | o que pode ser escrito |
| `update` | `USING (rule)` **e** `WITH CHECK (rule)` | quais linhas podem ser alvo, e no que podem se transformar |

O `UPDATE` sempre carrega um `WITH CHECK` explícito, então um update nunca consegue tirar uma linha da regra (por exemplo, trocar o `user_id` pelo id de outra pessoa). `policy.withCheck(using, check)` escreve `WITH CHECK (using AND check)`: a linha escrita precisa passar nos dois. Só `{ mode: 'replace' }` tira o `using` do `WITH CHECK`, para linhas que podem legitimamente sair dele.

### As policies miram a role mais restrita {#policies-target-the-narrowest-role}

Uma policy de `select` é concedida `TO public` só quando algum ramo pode ser verdadeiro para um visitante anônimo (`policy.public()`, `policy.custom(...)`, um `matchesField` de coluna para coluna); caso contrário, `TO authenticated`. Policies de escrita são `TO public` só quando um `policy.public()` explícito as decide. Você nunca escolhe a role: o predicado escolhe.

### Checagens de membership não entram em recursão nem podem ser chamadas por estranhos {#membership-checks-cannot-recurse-or-be-called-by-strangers}

`policy.belongsTo(..., { table, foreignKey, localKey })` e os tenants de `definePermissions` compilam para uma função helper:

```sql
CREATE OR REPLACE FUNCTION accessnexus_org_members_belongs_to_1_fn(p_value uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.org_members WHERE org_id = p_value AND user_id = (SELECT auth.uid()));
$$;
REVOKE EXECUTE ON FUNCTION accessnexus_org_members_belongs_to_1_fn(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accessnexus_org_members_belongs_to_1_fn(uuid) TO authenticated;
```

- `SECURITY DEFINER` deixa uma policy em `org_members` consultar `org_members` sem reentrar no próprio RLS (sem recursão infinita).
- `SET search_path = pg_catalog, public` e o `public.org_members` qualificado com o schema impedem que quem chama sombreie objetos pelo search path.
- O `EXECUTE` é revogado de `PUBLIC` e `anon`. Um helper usado por uma policy que também admite visitantes anônimos (`TO public`) é concedido a `anon` também, o que é seguro porque ele retorna false quando `auth.uid()` é null.

### Escritas são fixadas no `definePermissions` {#writes-are-pinned-in-definepermissions}

Por padrão:

- `create` também exige `ownerColumn = (SELECT auth.uid())`: ninguém cria linhas atribuídas a outra pessoa (`pinOwnerOnCreate`).
- `update`, e `create` quando o nível dele ainda não é escopado por tenant, também exigem membership no (novo) tenant da linha: um owner não consegue mover uma linha para outra org (`pinTenant`).

Os dois ficam ligados, a menos que você defina `pinOwnerOnCreate: false` ou `pinTenant: false`. Veja [Permissões](/pt/guide/permissions).

### Funções de trigger e de RPC são reforçadas {#trigger-and-rpc-functions-are-hardened}

- As funções de `trigger.auditLog` e `trigger.softDelete` são `SECURITY DEFINER` com `SET search_path = pg_catalog, public` e alvos qualificados com o schema. A tabela de auditoria mantém `insert: policy.none()`, então usuários não conseguem forjar entradas.
- Um guard de soft delete rejeita um `UPDATE` comum de um usuário da API que define ou limpa a coluna de soft delete. Só o `DELETE`, julgado pela policy de delete, pode fazer soft delete de uma linha.
- RPCs com `security: 'definer'` recebem `REVOKE EXECUTE ... FROM PUBLIC, anon` e um grant para `authenticated` e `service_role`, a menos que `allowAnon: true`.
- Toda função gerada fixa o `search_path`.

### Literais são escapados e identificadores são validados {#literals-are-quoted-and-identifiers-are-validated}

- Todo valor string que vai parar no SQL (`hasRole('admin')`, valores de `where` do `belongsTo`, as listas de colunas de `auditLog` e `lockColumns`) passa por uma função de quoting que duplica as aspas simples.
- Nomes de tabela, coluna e RPC são emitidos sem aspas, então o `validate` e os builders só aceitam snake_case minúsculo que não seja palavra reservada do SQL (`INVALID_IDENTIFIER`, `RESERVED_IDENTIFIER`).

### Roles globais vêm de uma claim que o usuário não consegue definir {#global-roles-come-from-a-claim-users-cannot-set}

`policy.hasRole('admin')` e arrays de roles no `definePermissions` leem `app_metadata.role` do JWT. Só o servidor consegue definir `app_metadata` (`supabase.auth.admin.updateUserById(id, { app_metadata: { role: 'admin' } })` com a service role, ou um custom access token hook). A claim `role` do nível de cima do JWT, que é a role `authenticated` do Postgres, nunca é usada.

### O `push` não cria helpers que quebram em silêncio {#push-will-not-create-helpers-that-break-silently}

Os helpers definer dependem de o dono deles passar por cima do RLS. O `push` checa se a role conectada tem `BYPASSRLS` (ou é superuser) sempre que o SQL contém `SECURITY DEFINER`, e recusa com `PUSH_ROLE_NO_BYPASSRLS` antes de aplicar qualquer coisa. Sem essa checagem, toda query com checagem de membership falharia com `stack depth limit exceeded`.

## Regras que você não pode quebrar {#rules-you-must-not-break}

Estas vêm direto da referência para agentes que acompanha o pacote (`node_modules/accessnexus/llms.txt`). Cada uma fecha um buraco que o gerador não consegue fechar por você, porque depende do que os seus dados significam.

### Mantenha toda tabela fechada por padrão {#keep-every-table-closed-by-default}

- Toda tabela que o client lê ou escreve tem `policies`. Use `policy.none()` para operações que devem ser bloqueadas.
- Nunca "resolva" um erro de permissão removendo policies, adicionando `enableRLS: false` ou usando `policy.public()` para escritas.
- Nunca use `policy.public()` (ou `'public'` no `definePermissions`) para insert, update ou delete, a menos que escritas anônimas tenham sido pedidas (`PUBLIC_WRITE`).
- A regra de `select` precisa admitir as linhas que o usuário acabou de inserir ou atualizar. O `create` e o `update` do SDK retornam a linha (`INSERT/UPDATE ... RETURNING`), o que falha com erro de RLS caso contrário. Numa tabela de membership, adicione `policy.isOwner('user_id')` ao `select`.

### Não vaze colunas privadas {#do-not-leak-private-columns}

- Nunca coloque colunas privadas (email, telefone, endereço) numa tabela cujo `select` é `policy.isAuthenticated()` ou `policy.public()`. No Supabase qualquer um pode se cadastrar, então "logado" significa "qualquer um".
- O RLS não consegue restringir colunas. Use uma tabela separada para dados privados, legível com `policy.isOwner(...)`.

### Fixe quem é dono de uma linha {#pin-who-owns-a-row}

- Uma tabela com chave no id do usuário (`profiles.id` referenciando `auth.users.id`) faz insert com `policy.isOwner('id')`, nunca `policy.isAuthenticated()`, que deixa qualquer um criar a linha de outro usuário (`USER_ROW_INSERT_OPEN`).
- Colunas de `policy.isOwner` são `uuid` e referenciam `auth.users.id` ou `profiles.id` (`OWNER_COLUMN_NOT_UUID`).
- Mantenha os pins de escrita do `definePermissions`. Desligue um só por um motivo concreto, e aí fixe a coluna certa você mesmo.
- Congele colunas de owner, criador e tenant com `trigger.lockColumns`. Uma regra de `UPDATE` nunca faz isso, porque o RLS é por linha.

### Acerte tenants e roles {#get-tenants-and-roles-right}

- Roles de org ou de time são roles de tenant (`{ scope: 'tenant', roles }`, ou `belongsTo` com `where: { role: [...] }`), não `policy.hasRole`, que vale para a plataforma inteira (`GLOBAL_ROLE_IN_TENANT_TABLE`).
- Checagens de membership passam por `belongsTo` com uma tabela de membership, ou pelos tenants do `definePermissions`. Não as reimplemente com subqueries em `policy.custom` na mesma tabela: isso entra em recursão. Condições de trigger como `lockColumns({ unless })` são a exceção; elas rodam como quem chama, fora de qualquer policy.
- Nunca use `belongsTo(col)` sem tabela de membership enquanto os usuários puderem escrever `profiles.<col>` (`BELONGS_TO_PROFILE_WRITABLE`): um usuário definiria o próprio `org_id` e entraria em qualquer tenant.
- Uma linha escopada por tenant que referencia outra linha escopada por tenant (tasks apontando para projects) precisa de um trigger de guard de mesmo tenant (`TENANT_PARENT_UNCHECKED`). Foreign keys são checadas sem RLS. Veja a [receita](/pt/guide/cookbook#child-of-a-tenant-resource).
- Nunca deixe um membro conceder uma role igual ou acima da sua. Restrinja inserts e updates na tabela de membership, por exemplo com `policy.custom("role = 'member'")` para editors.
- Nunca adicione uma regra de INSERT de "bootstrap" na tabela de membership ("o criador pode se adicionar como owner"). Ela continua válida para sempre, então um criador removido consegue voltar. Adicione o primeiro membro com um trigger AFTER INSERT `security: 'definer'` na tabela do tenant.

### Membership precisa de consentimento quando revela pessoas {#membership-needs-consent-when-it-reveals-people}

::: danger Visibilidade derivada de compartilhar um tenant
"Colegas de org podem ver meu perfil" só é privado se entrar numa org exigir o consentimento da pessoa. Se admins podem inserir qualquer `user_id` na tabela de membership, qualquer um pode criar uma org, adicionar um estranho e ler os dados dele como "co-membro".

Quando co-membros podem ler os dados pessoais uns dos outros, adicione pessoas só por um convite aceito: uma RPC `security: 'definer'` que checa o email convidado e **confirmado**, com o `insert` da tabela de membership definido como `policy.none()`. Caso contrário, mantenha colunas pessoais fora do que co-membros podem ler. Veja [Membership por convite](/pt/guide/cookbook#invitation-based-membership-consent).
:::

### SQL cru é responsabilidade sua {#raw-sql-is-your-responsibility}

- Nunca escreva `auth.uid()` / `auth.jwt()` sem o wrapper em `policy.custom` ou corpos de RPC. Sempre `(SELECT auth.uid())`.
- RPCs e triggers `security: 'definer'`, e a service role, ignoram o RLS: cheque quem chama lá dentro (veja [RPCs](/pt/guide/rpcs#check-the-caller-inside-a-definer-function)). Num corpo definer, qualifique as tabelas com o schema (`public.team_members`).
- Use `withCheck(using, check)` para adicionar condições sobre a linha escrita. Só use `{ mode: 'replace' }` quando a linha pode legitimamente sair do `using`.
- Não edite o SQL gerado para mudar comportamento. Altere o schema e gere de novo. Migrations aplicadas são imutáveis; o `push` recusa drift.

## O que o `validate` acusa {#what-validate-warns-about}

O `validate` (também executado por `generate`, `diff` e `push`) checa o schema estaticamente. Erros param o comando; warnings são impressos e devem ser tratados como bugs, a menos que a escolha seja deliberada.

| Código | Severidade | O que pega |
| --- | --- | --- |
| `NO_POLICIES` | warning | A tabela é deny-all para a API. Tudo bem para tabelas só do servidor; bug se o client usa. |
| `RLS_DISABLED` | warning | `enableRLS: false`: a tabela fica aberta para a anon key. |
| `RLS_DISABLED_WITH_POLICIES` | error | `enableRLS: false` mais policies que nunca seriam aplicadas. |
| `PUBLIC_WRITE` | warning | Insert, update ou delete aberto a visitantes anônimos via `policy.public()`. |
| `USER_ROW_INSERT_OPEN` | warning | Uma tabela com chave de usuário em que qualquer pessoa logada pode inserir. Use `policy.isOwner('id')`. |
| `TENANT_PARENT_UNCHECKED` | warning | Uma linha filha pode apontar para o pai de outro tenant. Adicione o guard de mesmo tenant. |
| `BELONGS_TO_PROFILE_WRITABLE` | error | Busca de tenant por uma coluna de profile que os usuários conseguem escrever. |
| `GLOBAL_ROLE_IN_TENANT_TABLE` | warning | `hasRole` misturado com checagens de tenant na mesma tabela; normalmente a intenção era uma role de tenant. |
| `UNWRAPPED_AUTH_CALL` | warning | `auth.uid()` / `auth.jwt()` / `auth.role()` sem o wrapper em SQL customizado, num corpo de RPC ou numa condição de `lockColumns`. |
| `AUDIT_INSERT_OPEN` | warning | Usuários conseguem inserir na tabela de auditoria, então conseguem forjar entradas. |
| `AUDIT_TABLE_MISMATCH` | error | A tabela de auditoria não tem as colunas que o trigger de auditoria escreve. |
| `OWNER_COLUMN_NOT_UUID` | error | `isOwner` numa coluna que não é `uuid`. |
| `UNKNOWN_COLUMN`, `UNKNOWN_TABLE` | error | Uma policy, trigger, referência ou índice cita algo que não existe. O TypeScript não pega isso no modo manual. |
| `INVALID_IDENTIFIER`, `RESERVED_IDENTIFIER` | error | Um nome que não pode ser emitido sem aspas. |
| `INVALID_ENUM_VALUE` | error | Um valor de `where` do `belongsTo` (por exemplo, uma role digitada errado) que não está no enum da coluna de membership. |

A lista completa, com as correções, está em [Solução de problemas](/pt/guide/troubleshooting#schema-validation-issues).

O `validate` não consegue provar que uma policy expressa o que você quis dizer. Ele checa estrutura, não intenção: um `isOwner` na coluna errada, ou uma RPC definer que esquece de checar quem chama, passa.

## O que o AccessNexus não protege {#what-accessnexus-does-not-protect}

::: warning Fora do alcance do gerador
- **Leituras por coluna.** O RLS decide quais linhas um usuário vê, nunca quais colunas. Se um usuário consegue ler uma linha, ele lê todas as colunas dela. Separe dados privados numa tabela própria. (`trigger.lockColumns` restringe quais colunas podem ser *escritas*, não lidas.)
- **A service role.** A key `service_role` e a conexão `postgres` ignoram o RLS completamente. Mantenha-as no servidor; nunca num bundle de browser, num app mobile ou num repositório público.
- **Código definer que você escreve.** RPCs e triggers `security: 'definer'` rodam com os direitos do dono. A segurança deles é exatamente tão boa quanto as checagens no corpo.
- **SQL cru que você escreve.** `policy.custom()`, `lockColumns({ unless })` e corpos de RPC são emitidos literalmente.
- **Objetos fora do schema.** Policies criadas no dashboard ou por outras migrations, funções que você escreveu à mão, storage buckets e outros schemas não são gerenciados. O Postgres combina policies permissivas com OR, então uma policy permissiva antiga continuaria concedendo acesso ao lado das geradas: nas tabelas que o schema gerencia, o `push` recusa com `FOREIGN_POLICIES` até você revisá-las e passar `--replace-foreign-policies`. Policies em tabelas fora do schema não são tocadas.
- **Regras removidas do schema.** Na v0.1.6, o `push` recria as policies que o schema declara, mas não remove uma policy gerada cuja operação você tirou (por exemplo, apagar `delete:` das `policies` de uma tabela), e não remove triggers ou RPCs removidos. Para revogar acesso, defina a operação como `policy.none()` em vez de apagar a chave, ou remova o objeto antigo à mão.
- **Os grants padrão do Supabase.** Tabelas e RPCs invoker mantêm os grants padrão do Supabase (`anon` e `authenticated` podem chamá-las); é o RLS que protege as linhas lá dentro.
- **Linhas com soft delete.** Elas continuam visíveis pelo RLS; só o SDK as filtra. Adicione `deleted_at IS NULL` ao `select` se leituras diretas pela API não devem vê-las.
:::

## Veja também {#related}

- [Policies](/pt/guide/policies) e [Permissões](/pt/guide/permissions)
- [RPCs](/pt/guide/rpcs): checando quem chama em código definer
- [Exemplos](/pt/guide/cookbook): as regras acima, aplicadas
- [Projetos existentes](/pt/guide/existing-project): como as policies importadas continuam fail-closed
- [Solução de problemas](/pt/guide/troubleshooting)
- [Limites e roadmap](/pt/guide/limits)
