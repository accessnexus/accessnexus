# policy

Builders da regra de acesso por linha de cada operação no `policies` de uma tabela. Guia: [Policies](/pt/guide/policies).

```ts
import { policy } from 'accessnexus';
```

Cada builder retorna um objeto de regra simples (`{ kind, ... }`). O [SupabaseAdapter](/pt/api/adapter) compila esse objeto em uma policy RLS do Postgres.

## Como uma regra vira policy {#how-a-rule-becomes-a-policy}

Uma policy por operação, com o nome `<prefix>_<table>_<operation>` (prefixo padrão `accessnexus`), precedida de `DROP POLICY IF EXISTS` (a menos que `adapterOptions.idempotent` seja `false`):

| Operação | Cláusulas |
| --- | --- |
| `select` | `USING (<rule>)` |
| `insert` | `WITH CHECK (<check of rule>)` |
| `update` | `USING (<rule>)` e um `WITH CHECK (<check of rule>)` explícito |
| `delete` | `USING (<rule>)` |

Em todo builder exceto `withCheck`, a expressão de check é igual à expressão da regra, então um UPDATE nunca consegue tirar uma linha da regra. Uma operação que fica de fora de `policies` não tem policy e é negada (o RLS está ligado).

```sql
DROP POLICY IF EXISTS "accessnexus_posts_update" ON posts;
CREATE POLICY "accessnexus_posts_update"
  ON posts FOR UPDATE
  TO authenticated
  USING (
    (SELECT auth.uid()) = author_id
  )
  WITH CHECK (
    (SELECT auth.uid()) = author_id
  );
```

### Role de destino (`TO ...`) {#target-role-to}

O AccessNexus escolhe a role; quem decide o acesso é sempre o predicado.

| Operação | `TO public` quando | Caso contrário |
| --- | --- | --- |
| `select` | algum ramo pode ser verdadeiro sem usuário logado: `policy.public()`, `policy.custom(...)` ou um `matchesField` sem chamada `auth.` em nenhum dos lados (`any` precisa de um ramo assim, `all` precisa que todos sejam) | `TO authenticated` |
| `insert`, `update`, `delete` | um `policy.public()` explícito decide (dentro de `any`, ou dentro de `all` junto apenas com ramos que podem passar sem usuário) | `TO authenticated` |

`auth.uid()` e `auth.jwt()` são sempre emitidos como `(SELECT auth.uid())` / `(SELECT auth.jwt())`, para que o Postgres os avalie uma vez por query (initPlan), e não uma vez por linha.

## Resumo {#summary}

| Builder | `kind` da regra | Predicado SQL |
| --- | --- | --- |
| [`isAuthenticated()`](#isauthenticated) | `authenticated` | `(SELECT auth.uid()) IS NOT NULL` |
| [`public()`](#public) | `public` | `TRUE` |
| [`none()`](#none) | `none` | `FALSE` |
| [`isOwner(column)`](#isowner) | `owner` | `(SELECT auth.uid()) = <column>` |
| [`hasRole(role)`](#hasrole) | `role` | `((SELECT auth.jwt()) -> 'app_metadata' ->> 'role') = '<role>'` |
| [`belongsTo(column, through?)`](#belongsto) | `belongs_to` | `(SELECT <prefix>_<table>_belongs_to_<n>_fn(<column>))` |
| [`matchesField(a, b)`](#matchesfield) | `matches_field` | `<a> = <b>` |
| [`custom(expression, adapter?)`](#custom) | `custom` | `<expression>` literalmente |
| [`any(rules)`](#any) | `any` | `(<r1>) OR (<r2>) ...` |
| [`all(rules)`](#all) | `all` | `(<r1>) AND (<r2>) ...` |
| [`withCheck(using, check, options?)`](#withcheck) | `with_check` | `USING (<using>)`, `WITH CHECK ((<using>) AND (<check>))` |

## isAuthenticated

Qualquer usuário logado.

```ts
isAuthenticated(): AuthenticatedRule; // { kind: 'authenticated' }
```

SQL: `(SELECT auth.uid()) IS NOT NULL`. Role: `authenticated`.

```ts
import { policy } from 'accessnexus';

export const policies = { select: policy.isAuthenticated() };
```

::: warning
No Supabase qualquer pessoa pode se cadastrar. Não use `isAuthenticated()` em `select` numa tabela com colunas privadas (e-mail, telefone, endereço), nem em `insert` numa tabela indexada pelo id do usuário (o `validate` avisa `USER_ROW_INSERT_OPEN`).
:::

## public

Todo mundo, inclusive visitantes anônimos.

```ts
public(): PublicRule; // { kind: 'public' }
```

SQL: `TRUE`. Role: `public`.

```ts
import { policy } from 'accessnexus';

export const policies = { select: policy.public() };
```

::: warning
Em `insert`, `update` ou `delete`, isso deixa qualquer pessoa com a sua anon key pública escrever na tabela. O `validate` avisa `PUBLIC_WRITE`.
:::

## none

Ninguém pela API. A service role, funções `SECURITY DEFINER` e triggers continuam ignorando o RLS.

```ts
none(): NoneRule; // { kind: 'none' }
```

SQL: `FALSE`. Role: `authenticated`.

```ts
import { policy } from 'accessnexus';

export const policies = { update: policy.none(), delete: policy.none() };
```

## isOwner

A linha pertence ao usuário atual.

```ts
isOwner(column: string): OwnerRule; // { kind: 'owner', column }
```

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `column` | `string` | Coluna com o id do usuário dono. Precisa ser `uuid` (`OWNER_COLUMN_NOT_UUID`). |

SQL: `(SELECT auth.uid()) = <column>`. Role: `authenticated`. A coluna é indexada automaticamente (`idx_<table>_<column>_rls`).

```ts
import { policy } from 'accessnexus';

export const policies = {
  select: policy.isOwner('user_id'),
  insert: policy.isOwner('user_id'),
  update: policy.isOwner('user_id'),
  delete: policy.isOwner('user_id'),
};
```

## hasRole

A role global do usuário na aplicação, lida da claim `app_metadata.role` do JWT.

```ts
hasRole(role: string): RoleRule; // { kind: 'role', role }
```

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `role` | `string` | Valor esperado de `app_metadata.role`. Vira um literal SQL entre aspas. |

SQL: `((SELECT auth.jwt()) -> 'app_metadata' ->> 'role') = '<role>'`. Role: `authenticated`.

`app_metadata` só pode ser escrito no servidor, por exemplo com `supabase.auth.admin.updateUserById(id, { app_metadata: { role: 'admin' } })` usando a service role, ou com um custom access token hook. A claim `role` de nível superior do JWT (a role do Postgres, `anon` / `authenticated`) não é usada.

```ts
import { policy } from 'accessnexus';

// A equipe da plataforma lê a trilha de auditoria
export const policies = { select: policy.hasRole('admin') };
```

::: warning
`hasRole` não é uma role dentro de uma org ou equipe. Para roles de tenant, use `{ scope: 'tenant', roles: [...] }` no [definePermissions](/pt/api/permissions) ou `belongsTo(..., { where: { role: [...] } })`. O `validate` avisa `GLOBAL_ROLE_IN_TENANT_TABLE` quando uma tabela mistura `hasRole` com checagens de associação.
:::

## belongsTo

O usuário atual é membro do grupo da linha (org, equipe, loja).

```ts
belongsTo(
  column: string,
  through?: {
    table: string;
    foreignKey: string;
    localKey: string;
    where?: Record<string, string | string[]>;
  },
): BelongsToRule; // { kind: 'belongs_to', column, through }
```

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `column` | `string` | Coluna desta tabela com o id do grupo. Precisa ser `uuid` (o helper recebe `p_value uuid`). |
| `through.table` | `string` | Tabela de associação, por exemplo `'org_members'`. |
| `through.foreignKey` | `string` | Coluna da associação com o id do grupo. |
| `through.localKey` | `string` | Coluna da associação com o id do usuário. |
| `through.where` | `Record<string, string \| string[]>` | Filtros extras na linha de associação. Um array vira `IN (...)`, uma string vira `= '...'`. Os valores são literais entre aspas. |

Cada `belongsTo` distinto numa tabela é compilado para um helper `SECURITY DEFINER` (um por assinatura, numerados a partir de 1), o que evita recursão de RLS mesmo na própria tabela de associação:

```sql
CREATE OR REPLACE FUNCTION accessnexus_posts_belongs_to_1_fn(p_value uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.org_members WHERE org_id = p_value AND user_id = (SELECT auth.uid()) AND role IN ('admin'));
$$;
REVOKE EXECUTE ON FUNCTION accessnexus_posts_belongs_to_1_fn(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accessnexus_posts_belongs_to_1_fn(uuid) TO authenticated;
```

O predicado da policy é `(SELECT accessnexus_posts_belongs_to_1_fn(org_id))`. Quando uma policy que usa o helper é concedida `TO public`, o helper também é concedido a `anon` (ele retorna false sem usuário).

Sem `through`, o helper checa `profiles.<column>` do usuário atual: `SELECT EXISTS (SELECT 1 FROM public.profiles WHERE <column> = p_value AND id = (SELECT auth.uid()))`.

```ts
import { policy } from 'accessnexus';

const members = { table: 'org_members', foreignKey: 'org_id', localKey: 'user_id' };

export const policies = {
  select: policy.belongsTo('org_id', members),
  delete: policy.belongsTo('org_id', { ...members, where: { role: ['admin'] } }),
};
```

::: warning
`belongsTo(column)` sem `through` confia em `profiles.<column>`. Se os usuários puderem inserir a própria linha de profile ou atualizar essa coluna, eles podem colocar qualquer id de tenant ali e entrar nesse tenant. O `validate` rejeita isso (`BELONGS_TO_PROFILE_WRITABLE`). Prefira `through`; para manter a consulta em profiles, use `insert: policy.none()` em profiles e `trigger.lockColumns({ columns: [column] })`.
:::

O `validate` checa se as colunas de `column`, `foreignKey`, `localKey` e `where` existem, e se os valores de `where` estão entre os valores de uma coluna enum (`INVALID_ENUM_VALUE`).

## matchesField

Dois valores precisam ser iguais.

```ts
matchesField(fieldA: string, fieldB: string): MatchesFieldRule; // { kind: 'matches_field', fieldA, fieldB }
```

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `fieldA` | `string` | Nome de coluna ou uma chamada de auth como `'auth.uid()'`. |
| `fieldB` | `string` | Nome de coluna ou uma chamada de auth. |

SQL: `<fieldA> = <fieldB>`. Um lado com `auth.<fn>(...)` puro é envolvido como `(SELECT auth.<fn>(...))`. Role em `select`: `public` quando nenhum lado contém `auth.`, senão `authenticated`. Nomes de coluna simples são checados pelo `validate` e indexados.

```ts
import { policy } from 'accessnexus';

export const policies = { insert: policy.matchesField('author_id', 'auth.uid()') };
// author_id = (SELECT auth.uid())
```

## custom

Predicado SQL cru, emitido literalmente.

```ts
custom(expression: string, adapter?: string): CustomRule; // { kind: 'custom', expression, adapter }
```

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `expression` | `string` | Expressão SQL booleana avaliada por linha. Não pode ser vazia (`INVALID_POLICY_RULE`). |
| `adapter` | `string` | Dica de adapter opcional. Fica guardada na regra; o adapter do Supabase a ignora. |

Role em `select`: `public` (o AccessNexus não tem como saber se a expressão precisa de usuário).

```ts
import { policy } from 'accessnexus';

export const policies = { select: policy.custom("status = 'published' AND deleted_at IS NULL") };
```

::: warning
A expressão não é escapada nem validada como SQL. Nunca interpole input do usuário nela. Escreva `(SELECT auth.uid())`, nunca um `auth.uid()` puro (aviso `UNWRAPPED_AUTH_CALL`). Não reimplemente checagens de associação com subqueries na mesma tabela; use `belongsTo` (recursão de RLS).
:::

## any

OR: passa quando qualquer regra passa.

```ts
any(rules: PolicyRule[]): AnyRule; // { kind: 'any', rules }
```

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `rules` | `PolicyRule[]` | Pelo menos uma regra (`EMPTY_COMBINATOR`). |

SQL: cada regra entre parênteses, unidas por `OR`; uma regra única é emitida sem envolver.

```ts
import { policy } from 'accessnexus';

export const policies = {
  select: policy.any([policy.isOwner('author_id'), policy.custom("status = 'published'")]),
};
```

## all

AND: passa só quando todas as regras passam.

```ts
all(rules: PolicyRule[]): AllRule; // { kind: 'all', rules }
```

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `rules` | `PolicyRule[]` | Pelo menos uma regra (`EMPTY_COMBINATOR`). |

SQL: cada regra entre parênteses, unidas por `AND`.

```ts
import { policy } from 'accessnexus';

export const policies = {
  update: policy.all([policy.isOwner('user_id'), policy.custom('locked = false')]),
};
```

## withCheck

Regras separadas para as linhas que o usuário pode alcançar (`USING`) e para a linha sendo escrita (`WITH CHECK`).

```ts
withCheck(
  using: PolicyRule,
  check: PolicyRule,
  options?: { mode?: WithCheckMode },
): WithCheckRule; // { kind: 'with_check', using, check, mode? }

type WithCheckMode = 'and' | 'replace';
```

| Parâmetro | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `using` | `PolicyRule` | obrigatório | Quais linhas existentes o usuário pode alcançar. Também é exigido da nova linha, a menos que `mode: 'replace'`. |
| `check` | `PolicyRule` | obrigatório | Condição sobre a linha escrita. |
| `options.mode` | `'and' \| 'replace'` | `'and'` | `'and'`: `WITH CHECK ((<using>) AND (<check>))`. `'replace'`: `WITH CHECK (<check>)`. |

| Operação | `USING` | `WITH CHECK` (`'and'`) | `WITH CHECK` (`'replace'`) |
| --- | --- | --- | --- |
| `select`, `delete` | `using` | nenhum | nenhum |
| `insert` | nenhum | `(using) AND (check)` | `check` |
| `update` | `using` | `(using) AND (check)` | `check` |

A chave `mode` só aparece na regra quando é passada. Um `withCheck` aninhado dentro de `any` / `all` contribui com seu `using` para o `USING` e com sua expressão de check para o `WITH CHECK`.

```ts
import { policy } from 'accessnexus';

export const policies = {
  // Autores editam seus comentários; toda edição precisa definir edited = true
  update: policy.withCheck(policy.isOwner('author_id'), policy.custom('edited = true')),
};

// A linha escrita pode sair da condição de `using` (publicar um rascunho)
export const publishDraft = policy.withCheck(
  policy.all([policy.isOwner('author_id'), policy.custom("status = 'draft'")]),
  policy.all([policy.isOwner('author_id'), policy.custom("status IN ('draft', 'published')")]),
  { mode: 'replace' },
);
```

::: warning
`mode: 'replace'` remove o `using` do `WITH CHECK`: um UPDATE pode então tirar uma linha da posse do usuário ou do tenant dele, a menos que o `check` repita essa condição. Mantenha o padrão, a não ser que a nova linha precise legitimamente sair do `using`, e repita a condição de posse no `check`.
:::

## Tipos {#types}

| Tipo | Formato |
| --- | --- |
| `PolicyOperation` | `'select' \| 'insert' \| 'update' \| 'delete'` |
| `PolicyRule` | `{ readonly kind: string }` (base de toda regra) |
| `TablePolicies` | `{ [op in PolicyOperation]?: PolicyRule }` |
| `WithCheckMode` | `'and' \| 'replace'` |

As interfaces concretas de regra (`AuthenticatedRule`, `OwnerRule`, `BelongsToRule`, ...) são os tipos de retorno mostrados acima; só `PolicyRule`, `PolicyOperation`, `TablePolicies` e `WithCheckMode` são exportados de `accessnexus`.
