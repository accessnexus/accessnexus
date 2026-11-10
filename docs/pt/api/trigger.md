# trigger

Builders para o array `triggers` de uma tabela. Cada um compila para uma função PL/pgSQL mais um `CREATE TRIGGER`, gravados em `<table>_triggers.sql`. Guia: [Triggers](/pt/guide/triggers).

```ts
import { trigger } from 'accessnexus';
```

## Saída comum {#common-output}

| Item | Valor |
| --- | --- |
| Nome da função | `<prefix>_<table>_<suffix>_fn` |
| Nome do trigger | `<prefix>_<table>_<suffix>` |
| `search_path` | toda função tem `SET search_path = pg_catalog, <schemaName>` (padrão `public`) |
| Idempotência | `CREATE OR REPLACE FUNCTION` e `DROP TRIGGER IF EXISTS` antes do `CREATE TRIGGER` (a menos que `adapterOptions.idempotent` seja `false`) |
| Granularidade | `FOR EACH ROW` (só `trigger.custom` pode escolher `statement`) |

`<prefix>` é o prefixo das policies (padrão `accessnexus`). Dois triggers com o mesmo sufixo numa tabela se substituiriam; o `validate` reporta `DUPLICATE_TRIGGER`.

| Builder | Sufixo | Dispara | Segurança |
| --- | --- | --- | --- |
| [`updatedAt`](#updatedat) | `updated_at` | `BEFORE UPDATE` | invoker |
| [`softDelete`](#softdelete) | `soft_delete`, `soft_delete_guard` | `BEFORE DELETE`, `BEFORE UPDATE OF <column>` | definer (delete), invoker (guard) |
| [`auditLog`](#auditlog) | `audit_log` | `AFTER INSERT OR UPDATE OR DELETE` | definer |
| [`lockColumns`](#lockcolumns) | `name` ou `lock_columns` | `BEFORE UPDATE` | invoker |
| [`custom`](#custom) | `name` | `events` | `security` (padrão invoker) |
| [`keepAtLeastOne`](#keepatleastone) | `name` ou `keep_<column>_<value>` | `BEFORE UPDATE OR DELETE` | definer |
| [`sameTenant`](#sametenant) | `name` ou `same_tenant_<column>` | `BEFORE INSERT OR UPDATE` | invoker |
| [`memberOfTenant`](#memberoftenant) | `name` ou `member_of_tenant_<column>` | `BEFORE INSERT OR UPDATE` | invoker |
| [`onAuthUserCreated`](#onauthusercreated) | `name` ou `on_auth_user_created` | `AFTER INSERT ON auth.users` | definer |

## updatedAt

Preenche uma coluna de timestamp a cada UPDATE.

```ts
updatedAt(column: string): UpdatedAtTrigger; // { kind: 'updated_at', column }
```

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `column` | `string` | Coluna de timestamp, normalmente `'timestamptz?'`. |

Corpo: `NEW.<column> = NOW(); RETURN NEW;`. O `trigger.lockColumns` nunca bloqueia uma coluna mantida pelo `updatedAt`.

```ts
import { table, trigger } from 'accessnexus';

export const posts = table({
  columns: { id: 'uuid', title: 'text', updated_at: 'timestamptz?' },
  primaryKey: 'id',
  triggers: [trigger.updatedAt('updated_at')],
});
```

## softDelete

Transforma DELETE em `SET <column> = NOW()`.

```ts
softDelete(column: string): SoftDeleteTrigger; // { kind: 'soft_delete', column }
```

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `column` | `string` | Coluna de timestamp nullable, ex.: `'deleted_at'`. |

Definir `softDelete: '<column>'` na tabela adiciona esse trigger automaticamente (e faz o SDK filtrar as linhas apagadas); usar os dois é reportado como `DUPLICATE_TRIGGER`.

Gerado:

1. `<prefix>_<table>_soft_delete_fn`, `SECURITY DEFINER`, `BEFORE DELETE`: `UPDATE <schema>.<table> SET <column> = NOW() WHERE <pk> = OLD.<pk>; RETURN NULL;` (cancela o delete). `<pk>` é a `primaryKey`, ou `id`.
2. `<prefix>_<table>_soft_delete_guard_fn`, invoker, `BEFORE UPDATE OF <column>`: lança SQLSTATE `42501` quando um usuário da API (`anon` / `authenticated`) altera a coluna com um UPDATE comum.

Por isso, quem decide quem pode fazer soft delete é a policy de DELETE; a policy de UPDATE não serve para fazer soft delete nem para restaurar. Restaure linhas com a service role ou com uma RPC `security: 'definer'`.

::: warning Atenção
Linhas com soft delete continuam visíveis pelo RLS; só o SDK as filtra. Para escondê-las das leituras diretas pela API, adicione a condição ao `select`, ex.: `policy.all([policy.isOwner('author_id'), policy.custom('deleted_at IS NULL')])`. `onDelete: 'cascade'` apontando para uma tabela com soft delete é rejeitado (`CASCADE_INTO_SOFT_DELETE`).
:::

## auditLog

Registra todo INSERT, UPDATE e DELETE numa tabela de auditoria.

```ts
auditLog(options: { table: string; columns?: string[] }): AuditLogTrigger;
// { kind: 'audit_log', table, columns }
```

| Opção | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `table` | `string` | obrigatório | Tabela de auditoria no schema. Qualificada com o nome do schema, a menos que contenha um ponto. |
| `columns` | `string[]` | todas as colunas | Registra só essas colunas (`JSONB_BUILD_OBJECT`) em vez da linha inteira (`TO_JSONB`). |

A função é `SECURITY DEFINER` e executa:

```sql
INSERT INTO public.audit_log (table_name, operation, old_data, new_data, changed_at)
VALUES (TG_TABLE_NAME, TG_OP,
  CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE TO_JSONB(OLD) END,
  CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE TO_JSONB(NEW) END,
  NOW());
RETURN COALESCE(NEW, OLD);
```

A tabela de auditoria precisa ter `table_name`, `operation`, `old_data`, `new_data`, `changed_at`, e todas as outras colunas precisam ser nullable ou ter um default (`AUDIT_TABLE_MISMATCH`). Mantenha a policy de `insert` dela como `policy.none()`: o trigger não precisa dela, e um insert aberto permite que usuários forjem registros (`AUDIT_INSERT_OPEN`).

```ts
import { defineSchema, policy, table, trigger } from 'accessnexus';

export default defineSchema({
  audit_log: table({
    columns: {
      id: 'uuid',
      table_name: 'text',
      operation: 'text',
      old_data: 'jsonb?',
      new_data: 'jsonb?',
      changed_at: { type: 'timestamptz', default: 'now()' },
    },
    primaryKey: 'id',
    policies: { select: policy.hasRole('admin'), insert: policy.none(), update: policy.none(), delete: policy.none() },
  }),
  invoices: table({
    columns: { id: 'uuid', owner_id: 'uuid', status: 'text' },
    primaryKey: 'id',
    triggers: [trigger.auditLog({ table: 'audit_log', columns: ['status'] })],
    policies: { select: policy.isOwner('owner_id'), update: policy.isOwner('owner_id') },
  }),
});
```

## lockColumns

Impede que usuários da API alterem certas colunas com UPDATE. O RLS decide quais linhas um usuário pode atualizar, nunca quais colunas.

```ts
lockColumns(options: {
  columns?: string[];
  except?: string[];
  unless?: string;
  name?: string;
}): LockColumnsTrigger; // { kind: 'lock_columns', ...só as opções passadas }
```

| Opção | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `columns` | `string[]` | `undefined` | Colunas que não podem mudar. Use esta ou `except`, não as duas (`INVALID_TRIGGER`). |
| `except` | `string[]` | `undefined` | Trava todas as colunas, exceto estas. |
| `unless` | `string` | `undefined` | Condição SQL crua (com `NEW` e `OLD` disponíveis) sob a qual a alteração é permitida. Um resultado `NULL` conta como falso. |
| `name` | `string` | `'lock_columns'` | Sufixo do trigger, em snake_case minúsculo. Precisa ser diferente quando a tabela tem dois triggers `lockColumns`. |

A função `BEFORE UPDATE` lança SQLSTATE `42501`, uma vez por coluna que mudou, quando todas estas condições valem:

- `current_user IN ('anon', 'authenticated')` — a service role e código `SECURITY DEFINER` nunca são bloqueados;
- `unless` não é verdadeiro;
- uma coluna travada mudou. Com `columns`: `NEW.c IS DISTINCT FROM OLD.c` para cada uma. Com `except`: a primeira chave (em ordem de chave) de `to_jsonb(NEW) - ARRAY[...]` cujo valor difere do de `to_jsonb(OLD)`, encontrada com `jsonb_each`.

O erro nomeia a coluna e leva um HINT estável:

| Campo | Valor |
| --- | --- |
| Mensagem | `<table>.<column> cannot be changed` |
| SQLSTATE | `42501` (o mesmo de uma negação do RLS) |
| HINT | `accessnexus:locked_column:<table>.<column>` |

O HINT é o que distingue uma coluna travada de uma negação do RLS: o [`isLockedColumn(error)`](/pt/api/sdk#helpers) do SDK gerado o confere.

Colunas mantidas por `trigger.updatedAt` na mesma tabela sempre podem mudar.

SQL gerado para `columns: ['reporter_id', 'org_id']` em `tasks`:

```sql
CREATE OR REPLACE FUNCTION accessnexus_tasks_lock_identity_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    IF NEW.reporter_id IS DISTINCT FROM OLD.reporter_id THEN
      RAISE EXCEPTION '%', 'tasks.' || 'reporter_id' || ' cannot be changed'
        USING ERRCODE = '42501', HINT = 'accessnexus:locked_column:tasks.' || 'reporter_id';
    END IF;
    IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
      RAISE EXCEPTION '%', 'tasks.' || 'org_id' || ' cannot be changed'
        USING ERRCODE = '42501', HINT = 'accessnexus:locked_column:tasks.' || 'org_id';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;
```

Com `except: ['status']`, a função encontra a chave que mudou em vez de listar colunas:

```sql
DECLARE
  locked_column text;
BEGIN
  IF current_user IN ('anon', 'authenticated') AND NOT COALESCE((<unless>), FALSE) THEN
    SELECT n.key INTO locked_column
      FROM jsonb_each(to_jsonb(NEW) - ARRAY['status', 'updated_at']::text[]) AS n
     WHERE n.value IS DISTINCT FROM (to_jsonb(OLD) -> n.key)
     ORDER BY n.key LIMIT 1;
    IF locked_column IS NOT NULL THEN
      RAISE EXCEPTION '%', 'tasks.' || locked_column || ' cannot be changed'
        USING ERRCODE = '42501', HINT = 'accessnexus:locked_column:tasks.' || locked_column;
    END IF;
  END IF;
  RETURN NEW;
END;
```

```ts
import { table, trigger } from 'accessnexus';

export const tasks = table({
  columns: { id: 'uuid', org_id: 'uuid', reporter_id: 'uuid', status: 'text', title: 'text' },
  primaryKey: 'id',
  triggers: [
    trigger.lockColumns({ name: 'lock_identity', columns: ['reporter_id', 'org_id'] }),
    trigger.lockColumns({
      except: ['status'],
      unless: "EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = NEW.org_id AND m.user_id = (SELECT auth.uid()) AND m.role = 'admin')",
    }),
  ],
});
```

::: warning Atenção
`unless` é SQL cru executado como o usuário que fez a chamada. Escreva `(SELECT auth.uid())`, não um `auth.uid()` solto (`UNWRAPPED_AUTH_CALL`), e nunca interpole entrada não confiável.
:::

## custom

Um trigger com o seu próprio corpo PL/pgSQL.

```ts
custom(options: {
  name: string;
  events: TriggerEvent[];
  functionBody: string;
  when?: string;
  forEach?: TriggerForEach;
  security?: 'invoker' | 'definer';
  set?: Record<string, string>;
  writes?: string[];
}): CustomTrigger;

type TriggerEvent =
  | 'before_insert' | 'after_insert'
  | 'before_update' | 'after_update'
  | 'before_delete' | 'after_delete';
type TriggerForEach = 'row' | 'statement';
```

| Opção | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `name` | `string` | obrigatório | Sufixo do trigger, em snake_case minúsculo (`INVALID_IDENTIFIER`). |
| `events` | `TriggerEvent[]` | obrigatório | Pelo menos um (`INVALID_TRIGGER`). |
| `functionBody` | `string` | obrigatório | Statements PL/pgSQL colocados entre `BEGIN` e `END;`. Precisa terminar com `RETURN NEW`, `RETURN OLD` ou `RETURN NULL`. |
| `when` | `string` | `undefined` | Condição SQL emitida como `WHEN (<when>)`. |
| `forEach` | `'row' \| 'statement'` | `'row'` | `FOR EACH ROW` ou `FOR EACH STATEMENT`. |
| `security` | `'invoker' \| 'definer'` | `'invoker'` | `'definer'` adiciona `SECURITY DEFINER`: o corpo roda como o dono da função e ignora o RLS. |
| `set` | `Record<string, string>` | `undefined` | Configuração da função, como em [`rpc`](/pt/api/rpc#options): `{ row_security: 'off' }` emite `SET row_security = 'off'`. O `search_path` continua fixado em `pg_catalog, public`. |
| `writes` | `string[]` | `undefined` | Outras tabelas que a função escreve, por exemplo `['team_members']`. Só o SDK usa: com `reactQuery: true`, uma mutation nesta tabela também invalida as queries dessas tabelas (`teams.create()` atualiza `team_members`). Não muda nenhum SQL. |

Os eventos são agrupados por momento: `['before_insert', 'before_update']` vira `BEFORE INSERT OR UPDATE`. O corpo é envolvido como `BEGIN <functionBody> END;`, então não pode ter uma seção `DECLARE` própria.

::: warning Atenção
Use eventos de um único momento em cada trigger. Misturar `before_*` e `after_*` gera `BEFORE ... OR AFTER ...`, que o Postgres rejeita no `push`; o `validate` não pega isso. Divida em dois triggers.
:::

```ts
import { trigger } from 'accessnexus';

export const lowerEmail = trigger.custom({
  name: 'lowercase_email',
  events: ['before_insert', 'before_update'],
  when: 'NEW.email IS NOT NULL',
  functionBody: 'NEW.email = lower(NEW.email); RETURN NEW;',
});

// Efeito colateral confiável: adiciona o criador como primeiro owner
export const addCreator = trigger.custom({
  name: 'add_creator_as_owner',
  events: ['after_insert'],
  security: 'definer',
  functionBody: "INSERT INTO public.team_members (team_id, user_id, role) VALUES (NEW.id, NEW.created_by, 'owner'); RETURN NEW;",
  writes: ['team_members'], // React Query: teams.create() also refreshes team_members
});
```

::: warning Atenção
`security: 'definer'` ignora o RLS em tudo o que o corpo lê e escreve. Use só para efeitos colaterais confiáveis, qualifique as tabelas com o schema (`public.team_members`) e verifique quem está chamando dentro do corpo quando isso importar.
:::

## keepAtLeastOne

Mantém pelo menos uma linha com `column = value` por `scope`: uma org sempre tem um owner. A última linha assim não pode ser apagada, nem alterada para outro valor.

```ts
keepAtLeastOne(options: {
  column: string;
  value: string;
  scope: string;
  parent?: string;
  name?: string;
}): KeepAtLeastOneTrigger; // { kind: 'keep_at_least_one', ...options }
```

| Opção | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `column` | `string` | obrigatório | Coluna que guarda o valor protegido, por exemplo `'role'`. |
| `value` | `string` | obrigatório | O valor protegido, por exemplo `'owner'`. |
| `scope` | `string` | obrigatório | Coluna que agrupa as linhas, por exemplo `'team_id'`: cada escopo precisa de uma. |
| `parent` | `string` | `undefined` | `'<table>.<column>'` do pai do escopo, por exemplo `'teams.id'`. Quando a linha pai some (um delete em cascata), a guarda se afasta, então apagar o time continua funcionando. |
| `name` | `string` | `keep_<column>_<value>` | Sufixo do trigger, em snake_case minúsculo. |

A tabela precisa de um único `primaryKey` (senão `INVALID_TRIGGER`). A função é `SECURITY DEFINER` (ela precisa ver todas as linhas do escopo, qualquer que seja o RLS de quem chama) e dispara em `BEFORE UPDATE OR DELETE`. Age quando a linha antiga tem `column = value` e a operação é um DELETE, ou muda `column` ou `scope`. Então trava as linhas do escopo com `SELECT ... FOR UPDATE`, para que dois rebaixamentos concorrentes não passem juntos, e lança SQLSTATE `23514` quando não sobra outra linha com o valor:

```sql
PERFORM 1 FROM public.team_members m WHERE m.team_id = OLD.team_id AND m.role = 'owner' FOR UPDATE;
IF NOT EXISTS (
  SELECT 1 FROM public.team_members m
  WHERE m.team_id = OLD.team_id AND m.role = 'owner' AND m.id <> OLD.id
) THEN
  RAISE EXCEPTION 'team_members: each team_id needs at least one role = owner'
    USING ERRCODE = '23514';
END IF;
```

Com `parent`, a condição exige também `EXISTS (SELECT 1 FROM public.teams p WHERE p.id = OLD.team_id)`.

```ts
import { trigger } from 'accessnexus';

// The last owner of a team cannot leave or be demoted; deleting the team still cascades.
export const keepOwner = trigger.keepAtLeastOne({ column: 'role', value: 'owner', scope: 'team_id', parent: 'teams.id' });
```

## sameTenant

`column` precisa referenciar uma linha do mesmo tenant. Foreign keys são checadas sem RLS, então sem isto um membro do tenant A poderia criar uma linha em A que aponta para a linha do tenant B (sondando os ids dele, pendurando linhas que somem em cascata com os dados de B). O `validate` avisa `TENANT_PARENT_UNCHECKED` quando a guarda falta.

```ts
sameTenant(options: {
  column: string;
  references: string;
  tenantColumn: string;
  referencesTenantColumn?: string;
  name?: string;
}): SameTenantTrigger; // { kind: 'same_tenant', ...options }
```

| Opção | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `column` | `string` | obrigatório | Coluna de foreign key desta tabela, por exemplo `'project_id'`. |
| `references` | `string` | obrigatório | Tabela para a qual a coluna aponta, por exemplo `'projects'` (casada pela primary key dela, ou `id`). |
| `tenantColumn` | `string` | obrigatório | A coluna de tenant desta tabela, por exemplo `'org_id'`. É também a coluna de tenant do pai, a menos que `referencesTenantColumn` seja informada. |
| `referencesTenantColumn` | `string` | `tenantColumn` | A coluna de tenant do pai, quando ela tem outro nome. |
| `name` | `string` | `same_tenant_<column>` | Sufixo do trigger, em snake_case minúsculo. |

A função é `SECURITY INVOKER` e dispara em `BEFORE INSERT OR UPDATE`. Roda como quem escreve: uma linha pai que o usuário não enxerga conta como inexistente, então a checagem nunca revela ids de outro tenant. Uma coluna `NULL` é permitida. Fora isso, um pai inexistente, ou de outro tenant, lança SQLSTATE `23503`:

```sql
IF NEW.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.id = NEW.project_id AND p.org_id = NEW.org_id) THEN
  RAISE EXCEPTION '%', 'tasks.project_id ' || NEW.project_id || ' is not in org_id ' || NEW.org_id
    USING ERRCODE = '23503';
END IF;
```

```ts
import { trigger } from 'accessnexus';

// tasks.project_id must be a project of the same org (NULL allowed)
export const sameOrg = trigger.sameTenant({ column: 'project_id', references: 'projects', tenantColumn: 'org_id' });
```

Combine com `trigger.lockColumns` em `org_id` e `project_id`, para que um UPDATE posterior não mova a linha. Exemplo completo: [Filho de um recurso de tenant](/pt/guide/cookbook#child-of-a-tenant-resource).

## memberOfTenant

`column` (um id de usuário) precisa ser membro do tenant da linha: um responsável, um revisor.

```ts
memberOfTenant(options: {
  column: string;
  tenant: { table: string; userColumn: string; tenantColumn: string };
  tenantColumn?: string;
  name?: string;
}): MemberOfTenantTrigger; // { kind: 'member_of_tenant', ...options }
```

| Opção | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `column` | `string` | obrigatório | Coluna que guarda o id do usuário, por exemplo `'assignee_id'`. |
| `tenant` | `{ table, userColumn, tenantColumn }` | obrigatório | A tabela de membership, como no [`definePermissions`](/pt/api/permissions). |
| `tenantColumn` | `string` | `tenant.tenantColumn` | A coluna de tenant da própria linha, quando ela tem outro nome que a da tabela de membership. |
| `name` | `string` | `member_of_tenant_<column>` | Sufixo do trigger, em snake_case minúsculo. |

Como o `sameTenant`, é `SECURITY INVOKER`, dispara em `BEFORE INSERT OR UPDATE`, roda como quem escreve, permite `NULL` e lança SQLSTATE `23503`:

```sql
IF NEW.assignee_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.team_members m WHERE m.user_id = NEW.assignee_id AND m.team_id = NEW.team_id) THEN
  RAISE EXCEPTION '%', 'tasks.assignee_id ' || NEW.assignee_id || ' is not a member of team_id ' || NEW.team_id
    USING ERRCODE = '23503';
END IF;
```

```ts
import { trigger } from 'accessnexus';

// assignee_id must be a member of the row's team (NULL allowed)
export const assigneeIsMember = trigger.memberOfTenant({
  column: 'assignee_id',
  tenant: { table: 'team_members', userColumn: 'user_id', tenantColumn: 'team_id' },
});
```

## onAuthUserCreated

Insere uma linha desta tabela sempre que um usuário se cadastra, para que o client nunca precise de um passo "garantir o profile".

```ts
onAuthUserCreated(options: {
  columns: Record<string, string>;
  name?: string;
}): OnAuthUserCreatedTrigger; // { kind: 'on_auth_user_created', ...options }
```

| Opção | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `columns` | `Record<string, string>` | obrigatório | Coluna desta tabela para uma expressão SQL sobre `NEW` (a linha de `auth.users`), por exemplo `{ id: 'NEW.id', display_name: "split_part(NEW.email, '@', 1)" }`. Cada expressão precisa ser SQL não vazio (`INVALID_TRIGGER`). |
| `name` | `string` | `on_auth_user_created` | Sufixo do trigger, em snake_case minúsculo. |

O trigger mora em `auth.users`, não na tabela. A função é `SECURITY DEFINER`, o `EXECUTE` dela é revogado de `PUBLIC`, `anon` e `authenticated`, e o insert usa `ON CONFLICT DO NOTHING`, então uma linha que já existe nunca bloqueia o cadastro:

```sql
CREATE OR REPLACE FUNCTION accessnexus_profiles_on_auth_user_created_fn()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, split_part(NEW.email, '@', 1))
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public;
REVOKE EXECUTE ON FUNCTION accessnexus_profiles_on_auth_user_created_fn() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS accessnexus_profiles_on_auth_user_created ON auth.users;
CREATE TRIGGER accessnexus_profiles_on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION accessnexus_profiles_on_auth_user_created_fn();
```

```ts
import { trigger } from 'accessnexus';

// On the profiles table: a row per new auth user
export const profileOnSignUp = trigger.onAuthUserCreated({
  columns: { id: 'NEW.id', display_name: "split_part(NEW.email, '@', 1)" },
});
```

::: warning Atenção
Remover o builder do schema não apaga o trigger em `auth.users`; apague-o à mão.
:::

## Tipos {#types}

Exportados de `accessnexus`: `TriggerRule` (`{ readonly kind: string }`), `TableTriggers` (`TriggerRule[]`), `TriggerEvent`, `TriggerForEach`, `UpdatedAtTrigger`, `SoftDeleteTrigger`, `AuditLogTrigger`, `LockColumnsTrigger`, `CustomTrigger`, `KeepAtLeastOneTrigger`, `SameTenantTrigger`, `MemberOfTenantTrigger`, `OnAuthUserCreatedTrigger`.
