# Policies

As `policies` de uma tabela decidem quem pode ler e escrever quais linhas. Você dá uma regra por operação, montada com `policy.*`, e o AccessNexus compila cada regra numa policy de RLS do Postgres. Esta página explica o modelo e cada builder, com o SQL que ele produz.

Para roles e regras multi-tenant compartilhadas entre tabelas, veja [Permissões](/pt/guide/permissions), que compila para os mesmos builders.

## O modelo {#the-model}

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table } from 'accessnexus';

export default defineSchema({
  notes: table({
    columns: { id: 'uuid', user_id: 'uuid', body: 'text' },
    primaryKey: 'id',
    references: { user_id: 'auth.users.id' },
    policies: {
      select: policy.isOwner('user_id'), // quais linhas ficam visíveis
      insert: policy.isOwner('user_id'), // o que pode ser escrito
      update: policy.isOwner('user_id'), // quais linhas podem ser alvo, e no que podem se transformar
      delete: policy.isOwner('user_id'), // quais linhas podem ser apagadas
    },
  }),
});
```

O RLS do Postgres tem dois tipos de cláusula, e cada operação os usa de um jeito:

| Operação | `USING` (linhas existentes) | `WITH CHECK` (a linha sendo escrita) |
| --- | --- | --- |
| `select` | Quais linhas ficam visíveis | - |
| `insert` | - | Quais linhas novas são permitidas |
| `update` | Quais linhas o usuário pode alterar | Como a linha pode ficar depois |
| `delete` | Quais linhas podem ser apagadas | - |

No `update`, o AccessNexus sempre emite um `WITH CHECK` explícito com a mesma regra do `USING`, então a linha atualizada ainda precisa satisfazer a regra: um dono não consegue trocar o `user_id` para outra pessoa e entregar a linha. A checagem fica visível no SQL gerado, em vez de depender de o Postgres reaproveitar o `USING` implicitamente. Use [`policy.withCheck`](#policy-withcheck-using-check-options) para adicionar condições sobre a linha escrita.

Regras práticas:

- **Uma operação sem regra é negada.** Deixar `delete` de fora é o mesmo que `delete: policy.none()`, mas escrever `none()` deixa isso explícito.
- **Uma tabela sem `policies` nega tudo** para a API. Toda tabela recebe `ENABLE` + `FORCE ROW LEVEL SECURITY`.
- **As chaves de policy são `select`, `insert`, `update`, `delete`, mais `all`.** `read` / `create` são ações de [permissão](/pt/guide/permissions); usadas aqui, falham com `UNKNOWN_POLICY_OPERATION`.

### Uma regra para todas as operações: `all` {#one-rule-for-every-operation-all}

`all` aplica uma regra a `select`, `insert`, `update` e `delete`; uma chave por operação a sobrescreve:

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table } from 'accessnexus';

export default defineSchema({
  notes: table({
    columns: { id: 'uuid', user_id: 'uuid', body: 'text' },
    primaryKey: 'id',
    references: { user_id: 'auth.users.id' },
    policies: {
      all: policy.isOwner('user_id'),
      delete: policy.none(), // bloqueia uma operação explicitamente
    },
  }),
});
```

Ela é expandida na definição da tabela em uma policy por operação (`<prefix>_<table>_<op>`), nunca numa policy `FOR ALL` do Postgres, então `select`/`delete` recebem `USING`, `insert` recebe `WITH CHECK` e `update` os dois, exatamente como se estivessem escritas uma a uma. Uma chave definida como `undefined` não sobrescreve `all`; use `policy.none()` para bloquear uma operação. O `validate` checa cada operação expandida: `all: policy.public()` gera `PUBLIC_WRITE` nas escritas, e `all: policy.isAuthenticated()` numa tabela ligada a `auth.users` gera `USER_ROW_INSERT_OPEN` no `insert`.

A chave `all` não é o combinador [`policy.all([...])`](#policy-any-and-policy-all), que faz AND de regras dentro de uma operação. Os dois se combinam: `policies: { all: policy.all([a, b]) }`.

### Qual role uma policy atinge {#which-role-a-policy-targets}

Você nunca define a role do Postgres (`TO ...`). O predicado decide:

- Uma policy de `select` é concedida `TO public` quando algum ramo pode ser verdadeiro para um visitante anônimo (`policy.public()`, `policy.custom(...)`, um `matchesField` de coluna com coluna). Caso contrário, é `TO authenticated`.
- Policies de escrita são `TO public` só quando um `policy.public()` explícito as decide. Caso contrário, `TO authenticated`.

Então `select: policy.any([policy.custom('published = true'), policy.isOwner('author_id')])` é de fato legível por visitantes deslogados, enquanto `insert: policy.isOwner('author_id')` não é.

### Nomes das policies geradas {#generated-policy-names}

As policies se chamam `<prefix>_<table>_<operation>`, por exemplo `accessnexus_notes_select`. Mude o prefixo com `naming.policyPrefix` em `accessnexus.config.ts` ou com `--prefix`. Cada arquivo de policy apaga e recria as próprias policies, então reaplicá-lo é seguro.

## Builders num relance {#builders-at-a-glance}

| Builder | Compila para |
| --- | --- |
| `policy.isAuthenticated()` | `(SELECT auth.uid()) IS NOT NULL` |
| `policy.public()` | `TRUE` |
| `policy.none()` | `FALSE` |
| `policy.isOwner(col)` | `(SELECT auth.uid()) = col` |
| `policy.hasRole(role)` | `((SELECT auth.jwt()) -> 'app_metadata' ->> 'role') = 'role'` |
| `policy.belongsTo(col, through)` | Um helper de associação `SECURITY DEFINER` chamado com `col` |
| `policy.matchesField(a, b)` | `a = b` |
| `policy.custom(sql)` | `sql`, como escrito |
| `policy.any([...])` | `(...) OR (...)` |
| `policy.all([...])` | `(...) AND (...)` |
| `policy.withCheck(using, check, options?)` | `USING (using)`, `WITH CHECK (using AND check)` |

O SQL abaixo foi copiado de saídas reais do `generate`. Os comentários de cabeçalho e a linha `DROP POLICY IF EXISTS` antes de cada `CREATE POLICY` foram omitidos.

## `policy.isAuthenticated()`

Qualquer usuário logado.

```ts
import { policy } from 'accessnexus';

export const signedIn = policy.isAuthenticated();
```

```sql
CREATE POLICY "accessnexus_drafts_insert"
  ON drafts FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT auth.uid()) IS NOT NULL
  );
```

::: danger Não serve para inserts vinculados ao usuário
No Supabase qualquer um pode se cadastrar, então "estar logado" é uma barreira baixa. Numa tabela cuja chave é o id do usuário (`profiles.id` → `auth.users.id`), `insert: policy.isAuthenticated()` deixa qualquer usuário criar a linha **de outro usuário**. Use `policy.isOwner('id')`. O `validate` avisa `USER_ROW_INSERT_OPEN`.

Também nunca coloque colunas privadas (e-mail, telefone, endereço) numa tabela cujo `select` seja `isAuthenticated()` ou `public()`: qualquer conta conseguiria listá-las.
:::

## `policy.public()`

Todo mundo, inclusive visitantes anônimos. Use só para leituras.

```ts
import { policy } from 'accessnexus';

export const everyone = policy.public();
```

```sql
CREATE POLICY "accessnexus_announcements_select"
  ON announcements FOR SELECT
  TO public
  USING (
    TRUE
  );
```

::: danger
`policy.public()` em `insert`, `update` ou `delete` deixa qualquer um com a sua anon key escrever na tabela. O `validate` avisa `PUBLIC_WRITE`. Só use quando escritas anônimas forem pedidas explicitamente.
:::

## `policy.none()`

Ninguém pela API. A service role, triggers e código `SECURITY DEFINER` ignoram o RLS e continuam funcionando.

```ts
import { policy } from 'accessnexus';

export const nobody = policy.none();
```

```sql
CREATE POLICY "accessnexus_drafts_delete"
  ON drafts FOR DELETE
  TO authenticated
  USING (
    FALSE
  );
```

Usos típicos: `delete: policy.none()` em profiles, e `insert` / `update` / `delete: policy.none()` numa tabela de auditoria só de acréscimo que apenas um trigger escreve.

## `policy.isOwner(column)`

A linha pertence ao usuário atual. A coluna precisa ser `uuid`, geralmente referenciando `auth.users.id` ou `profiles.id` (caso contrário, `OWNER_COLUMN_NOT_UUID`).

```ts
import { policy } from 'accessnexus';

export const owner = policy.isOwner('user_id');
```

```sql
CREATE POLICY "accessnexus_notes_select"
  ON notes FOR SELECT
  TO authenticated
  USING (
    (SELECT auth.uid()) = user_id
  );
```

`auth.uid()` fica dentro de uma subquery para que o Postgres o avalie uma vez por query em vez de uma vez por linha.

## `policy.hasRole(role)`

Uma role **global** da aplicação, lida do claim `app_metadata.role` do JWT.

```ts
import { policy } from 'accessnexus';

// Só a equipe da plataforma
export const platformAdmin = policy.hasRole('admin');
```

```sql
CREATE POLICY "accessnexus_announcements_insert"
  ON announcements FOR INSERT
  TO authenticated
  WITH CHECK (
    ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role') = 'admin'
  );
```

O `app_metadata` só pode ser definido no servidor, por exemplo com a service role: `supabase.auth.admin.updateUserById(id, { app_metadata: { role: 'admin' } })`, ou com um custom access token hook. O claim `role` de nível superior do JWT nunca é usado: no Supabase ele é a role do Postgres (`authenticated`).

::: warning Role global, não role da org
"Admins desta organização" é uma role de **tenant** guardada na sua tabela de membros. Use `belongsTo` com `where` ou `{ scope: 'tenant', roles }` em [Permissões](/pt/guide/permissions). O `validate` avisa `GLOBAL_ROLE_IN_TENANT_TABLE` quando uma tabela mistura as duas.
:::

## `policy.belongsTo(column, through)`

O usuário atual é membro do grupo da linha (org, time, workspace). Passe a tabela de membros como `through`:

| Campo de `through` | Significado |
| --- | --- |
| `table` | Tabela de membros, por exemplo `'org_members'` |
| `foreignKey` | A coluna dela que guarda o id do grupo, por exemplo `'org_id'` |
| `localKey` | A coluna dela que guarda o id do usuário, por exemplo `'user_id'` |
| `where` | Filtros extras opcionais, por exemplo `{ role: ['admin', 'manager'] }` |

```ts
import { policy } from 'accessnexus';

export const member = policy.belongsTo('org_id', {
  table: 'org_members', foreignKey: 'org_id', localKey: 'user_id',
});

export const orgAdmin = policy.belongsTo('org_id', {
  table: 'org_members', foreignKey: 'org_id', localKey: 'user_id', where: { role: ['admin'] },
});
```

A consulta de associação vira uma função helper blindada, chamada pela policy:

```sql
CREATE OR REPLACE FUNCTION accessnexus_orgs_belongs_to_1_fn(p_value uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.org_members WHERE org_id = p_value AND user_id = (SELECT auth.uid()));
$$;
REVOKE EXECUTE ON FUNCTION accessnexus_orgs_belongs_to_1_fn(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accessnexus_orgs_belongs_to_1_fn(uuid) TO authenticated;

CREATE POLICY "accessnexus_orgs_select"
  ON orgs FOR SELECT
  TO authenticated
  USING (
    (SELECT accessnexus_orgs_belongs_to_1_fn(id))
  );
```

Com `where: { role: ['admin'] }`, o helper acrescenta `AND role IN ('admin')`. Um valor de `where` que não está no enum da coluna de membros (uma role digitada errado) falha no `validate` com `INVALID_ENUM_VALUE`.

Por que uma função `SECURITY DEFINER`: uma policy em `org_members` que consulta `org_members` entraria em recursão no próprio RLS. O helper roda como seu dono, pula o RLS só nessa consulta, tem `search_path` fixado e não pode ser executado por `anon`. Se uma policy que o usa também for concedida `TO public`, o helper é concedido a `anon` também, o que é seguro porque ele retorna false sem usuário.

::: tip Não reescreva checagens de associação com `policy.custom`
Uma subquery na tabela de membros dentro de uma policy custom traz de volta o problema de recursão e pula a blindagem. Use `belongsTo` ou tenants do `definePermissions`.
:::

### Sem `through` {#without-through}

`policy.belongsTo('org_id')` sem o segundo argumento verifica o `profiles.org_id` do usuário atual:

```sql
SELECT EXISTS (SELECT 1 FROM public.profiles WHERE org_id = p_value AND id = (SELECT auth.uid()));
```

::: danger Só é seguro quando os usuários nunca podem escrever essa coluna do perfil
Se um usuário pode inserir ou atualizar o próprio `profiles.org_id`, ele coloca ali o id de outro tenant e entra nesse tenant. O `validate` rejeita esse caso com `BELONGS_TO_PROFILE_WRITABLE`. Para manter a consulta em profiles, faça a coluna ser escrita só pelo servidor: `insert: policy.none()` em profiles (crie-os a partir de um trigger de auth ou da service role) e `trigger.lockColumns({ columns: ['org_id'] })`. Prefira uma tabela de membros.
:::

## `policy.matchesField(a, b)`

Dois valores precisam ser iguais. Qualquer lado pode ser uma coluna ou uma chamada de auth como `'auth.uid()'`, que é envolvida automaticamente.

```ts
import { policy } from 'accessnexus';

export const sameUser = policy.matchesField('author_id', 'auth.uid()');
```

```sql
CREATE POLICY "accessnexus_drafts_select"
  ON drafts FOR SELECT
  TO authenticated
  USING (
    author_id = (SELECT auth.uid())
  );
```

## `policy.custom(sql)`

Um predicado SQL cru, emitido como escrito. É a válvula de escape para condições sobre as próprias colunas da linha.

```ts
import { policy } from 'accessnexus';

export const published = policy.custom("status = 'published'");
```

::: warning
- Sempre escreva `(SELECT auth.uid())`, nunca um `auth.uid()` ou `auth.jwt()` solto. O `validate` avisa `UNWRAPPED_AUTH_CALL`.
- Nomes de coluna dentro de SQL custom não são verificados. Prefira um builder semântico quando houver um que sirva.
- Uma regra de `select` com um ramo custom é concedida `TO public`: garanta que esse ramo é mesmo para visitantes anônimos.
:::

## `policy.any([...])` e `policy.all([...])` {#policy-any-and-policy-all}

`any` é OR, `all` é AND. Eles podem ser aninhados.

```ts
import { policy } from 'accessnexus';

export const ownerOrPublished = policy.any([policy.custom('published = true'), policy.isOwner('author_id')]);

export const adminAuthor = policy.all([
  policy.isOwner('author_id'),
  policy.belongsTo('org_id', { table: 'org_members', foreignKey: 'org_id', localKey: 'user_id', where: { role: ['admin'] } }),
]);
```

```sql
CREATE POLICY "accessnexus_articles_select"
  ON articles FOR SELECT
  TO public
  USING (
    (published = true)
    OR ((SELECT auth.uid()) = author_id)
  );

CREATE POLICY "accessnexus_articles_insert"
  ON articles FOR INSERT
  TO authenticated
  WITH CHECK (
    ((SELECT auth.uid()) = author_id)
    AND ((SELECT accessnexus_articles_belongs_to_1_fn(org_id)))
  );
```

Uma lista vazia falha no `validate` com `EMPTY_COMBINATOR`.

## `policy.withCheck(using, check, options?)`

Separa "quais linhas posso alterar" de "o que posso escrever". Por padrão, a linha escrita precisa passar nas **duas** regras, então a condição de dono ou de tenant em `using` nunca pode ser apagada por uma escrita.

```ts
import { policy } from 'accessnexus';

// Autores editam os próprios artigos, e toda edição precisa definir edited = true
export const editOwn = policy.withCheck(policy.isOwner('author_id'), policy.custom('edited = true'));
```

```sql
CREATE POLICY "accessnexus_articles_update"
  ON articles FOR UPDATE
  TO authenticated
  USING (
    (SELECT auth.uid()) = author_id
  )
  WITH CHECK (
    ((SELECT auth.uid()) = author_id)
    AND (edited = true)
  );
```

Com `{ mode: 'replace' }`, o `WITH CHECK` é só a segunda regra. Use quando a linha pode legitimamente sair da condição de `using`, como ao publicar um rascunho:

```ts
import { policy } from 'accessnexus';

export const publishDraft = policy.withCheck(
  policy.all([policy.isOwner('author_id'), policy.custom("status = 'draft'")]),
  policy.all([policy.isOwner('author_id'), policy.custom("status IN ('draft', 'published')")]),
  { mode: 'replace' },
);
```

```sql
CREATE POLICY "accessnexus_drafts_update"
  ON drafts FOR UPDATE
  TO authenticated
  USING (
    ((SELECT auth.uid()) = author_id)
    AND (status = 'draft')
  )
  WITH CHECK (
    ((SELECT auth.uid()) = author_id)
    AND (status IN ('draft', 'published'))
  );
```

::: warning Mantenha a condição de dono na regra substituta
No modo `replace`, tudo o que você deixar fora da segunda regra deixa de ser exigido na linha escrita. Repita ali a condição de dono ou de tenant, como acima.
:::

`withCheck` foi feito para `update` e `insert`. No `insert` não existe `USING`, então as duas regras vão para o `WITH CHECK`. No `delete`, que só tem `USING`, a regra `check` não tem efeito.

## Armadilhas {#pitfalls}

### A regra de `select` precisa admitir o que o usuário acabou de escrever {#the-select-rule-must-admit-what-the-user-just-wrote}

O `create` e o `update` do SDK retornam a linha (`INSERT ... RETURNING`, `UPDATE ... RETURNING`). O Postgres confere a linha retornada contra a policy de `select`, então um usuário que pode inserir mas não ler a linha recebe um erro de RLS. Numa tabela de membros, adicione `policy.isOwner('user_id')` ao `select` para que um novo membro veja a própria linha.

### RLS não restringe colunas {#rls-cannot-restrict-columns}

Uma regra de `update` decide **quais linhas** um usuário pode alterar, nunca **quais colunas**. `update: policy.isOwner('assignee_id')` também deixa o responsável reescrever o título, o autor ou o tenant. Congele colunas com [`trigger.lockColumns`](/pt/guide/triggers#trigger-lockcolumns).

### Não corrija erros de permissão abrindo a tabela {#do-not-fix-permission-errors-by-opening-the-table}

Nunca "corrija" um erro de RLS removendo policies, adicionando `enableRLS: false` ou usando `policy.public()` numa escrita. Escreva a regra certa.

## Próximos passos {#next-steps}

- [Permissões](/pt/guide/permissions) - roles e tenants definidos uma vez, aplicados por tabela
- [Triggers](/pt/guide/triggers) - travas de coluna e outras lógicas por linha que o RLS não expressa
- [Modelo de segurança](/pt/guide/security) - todas as regras que o SQL gerado segue
- [API de policy](/pt/api/policy) - assinaturas e tipos completos
