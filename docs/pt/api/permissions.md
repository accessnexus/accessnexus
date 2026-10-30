# definePermissions

RBAC centralizado: declare uma única vez quem pode ler, criar, atualizar e apagar cada recurso, e transforme isso em policies de tabela. Guia: [Permissões e tenants](/pt/guide/permissions).

```ts
function definePermissions<R extends string>(input: PermissionsInput<R>): PermissionsDef<R>;
```

`R` é inferido das chaves de `resources`, então `policiesFor` e `can` só aceitam nomes de recursos declarados.

```ts
import { defineSchema, definePermissions, policy, table } from 'accessnexus';

export const permissions = definePermissions({
  roles: ['admin', 'manager', 'member'],
  tenant: { table: 'org_members', userColumn: 'user_id', tenantColumn: 'org_id', roleColumn: 'role' },
  resources: {
    projects: {
      ownerColumn: 'created_by',
      tenantColumn: 'org_id',
      read: { scope: 'tenant' },
      create: { scope: 'tenant', roles: ['admin', 'manager'] },
      update: { any: ['own', { scope: 'tenant', roles: ['admin', 'manager'] }] },
      delete: { scope: 'tenant', roles: ['admin'] },
    },
  },
});

export default defineSchema({
  org_members: table({
    columns: { id: 'uuid', org_id: 'uuid', user_id: 'uuid', role: "enum('admin','manager','member')" },
    primaryKey: 'id',
    policies: { select: policy.isOwner('user_id') },
  }),
  projects: table({
    columns: { id: 'uuid', org_id: 'uuid', created_by: 'uuid', name: 'text' },
    primaryKey: 'id',
    policies: permissions.policiesFor('projects'),
  }),
});
```

## PermissionsInput

```ts
interface PermissionsInput<R extends string = string> {
  roles: string[];
  tenant?: TenantConfig;
  resources: Record<R, ResourcePermissions>;
}
```

| Campo | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `roles` | `string[]` | obrigatório | Todo nome de role usado em qualquer lugar de `resources` (arrays de roles globais e `roles` de tenant). Usado só para validação. |
| `tenant` | `TenantConfig` | `undefined` | Tabela de associação. Obrigatória quando algum recurso usa `{ scope: 'tenant' }`. |
| `resources` | `Record<R, ResourcePermissions>` | obrigatório | Uma entrada por tabela, indexada pelo nome da tabela. |

## TenantConfig

```ts
interface TenantConfig {
  table: string;
  userColumn: string;
  tenantColumn: string;
  roleColumn?: string;
}
```

| Campo | Tipo | Descrição |
| --- | --- | --- |
| `table` | `string` | Tabela de associação (join), por exemplo `'org_members'`. |
| `userColumn` | `string` | Coluna da associação com o id do usuário. |
| `tenantColumn` | `string` | Coluna da associação com o id do tenant. |
| `roleColumn` | `string` | Coluna da associação com a role do usuário dentro do tenant. Exigida por `{ scope: 'tenant', roles }`. |

## ResourcePermissions

```ts
interface ResourcePermissions {
  ownerColumn?: string;
  tenantColumn?: string;
  pinTenant?: boolean;
  pinOwnerOnCreate?: boolean;
  read?: PermissionLevel;
  create?: PermissionLevel;
  update?: PermissionLevel;
  delete?: PermissionLevel;
  all?: PermissionLevel;
}
```

| Campo | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `ownerColumn` | `string` | `undefined` | Coluna com o id do usuário dono (`uuid`). Exigida por `'own'`. |
| `tenantColumn` | `string` | `undefined` | Coluna desta tabela com o id do tenant (`uuid`). Exigida por `{ scope: 'tenant' }`. Use `'id'` na própria tabela de tenants. |
| `pinTenant` | `boolean` | `true` | As escritas precisam manter a linha num tenant ao qual o usuário pertence. Veja [Pins de escrita](#write-pins). |
| `pinOwnerOnCreate` | `boolean` | `true` | `create` exige `ownerColumn = auth.uid()`. Veja [Pins de escrita](#write-pins). |
| `read` | `PermissionLevel` | nenhum | Compila para a policy de `select`. |
| `create` | `PermissionLevel` | nenhum | Compila para a policy de `insert`. |
| `update` | `PermissionLevel` | nenhum | Compila para a policy de `update`. |
| `delete` | `PermissionLevel` | nenhum | Compila para a policy de `delete`. |
| `all` | `PermissionLevel` | nenhum | Preenche `read`, `create`, `update` e `delete` que não têm nível próprio: `{ ownerColumn: 'user_id', all: 'own', read: '*' }`. Os pins de escrita valem para o `create`/`update` expandidos como se estivessem escritos. |

Uma ação que fica de fora não gera policy, então é negada assim que a tabela tem policies.

## PermissionLevel

```ts
type PermissionLevel = '*' | 'public' | 'none' | 'own' | string[] | TenantScope | AnyPermission;

interface TenantScope { scope: 'tenant'; roles?: string[] }
interface AnyPermission { any: PermissionLevel[] }
```

| Nível | Significado | Compila para |
| --- | --- | --- |
| `'public'` | todo mundo, inclusive visitantes anônimos | `policy.public()` |
| `'*'` | qualquer usuário logado | `policy.isAuthenticated()` |
| `'none'` | ninguém pela API | `policy.none()` |
| `'own'` | o dono da linha | `policy.isOwner(ownerColumn)` |
| `[]` | ninguém | `policy.none()` |
| `['admin']` | role global da aplicação (`app_metadata.role` do JWT) | `policy.hasRole('admin')` |
| `['admin', 'staff']` | qualquer uma dessas roles globais | `policy.any([policy.hasRole('admin'), policy.hasRole('staff')])` |
| `{ scope: 'tenant' }` | membro do tenant da linha | `policy.belongsTo(tenantColumn, { table, foreignKey: tenant.tenantColumn, localKey: tenant.userColumn })` |
| `{ scope: 'tenant', roles: ['admin'] }` | membro com uma dessas roles no tenant | o mesmo, com `where: { [tenant.roleColumn]: ['admin'] }` |
| `{ any: [...] }` | OR dos níveis | `policy.any([...])` (uma entrada única não é envolvida) |

::: warning
Um array de roles (`['admin']`) é uma role global da aplicação, lida de `app_metadata.role`, e não uma role dentro de uma org ou equipe. Para "admins da org", use `{ scope: 'tenant', roles: ['admin'] }`. O `validate` avisa `GLOBAL_ROLE_IN_TENANT_TABLE` quando uma tabela mistura os dois.
:::

## Pins de escrita {#write-pins}

Níveis de `create` e `update` diferentes de `'public'` e `'none'` ganham condições extras sobre a linha escrita. A regra do nível fica no `USING`; os pins entram com AND no `WITH CHECK` via [`policy.withCheck(rule, pins)`](/pt/api/policy#withcheck) (modo `'and'` padrão, então a própria regra também fica no `WITH CHECK`).

| Pin | Aplica-se a | Condição adicionada | Aplicado quando |
| --- | --- | --- | --- |
| tenant | `create`, `update` | `belongsTo(tenantColumn, tenant)` (associação, sem filtro de role) | `pinTenant !== false`, `tenant` está configurado, `tenantColumn` está definido, o nível não é ele mesmo um `{ scope: 'tenant' }` de nível superior, e não é (`create` com `tenantColumn: 'id'`) |
| owner | só `create` | `isOwner(ownerColumn)` | `ownerColumn` está definido, `pinOwnerOnCreate !== false` e o nível não é `'own'` |

Os dois pins são combinados com `policy.all`.

- `pinOwnerOnCreate: false` — quando outras pessoas atribuem a coluna de dono (por exemplo, o `assignee_id` de uma tarefa). Faça você mesmo o pin da coluna do criador real.
- `pinTenant: false` — para recursos escritos por quem não é membro (um cliente fazendo uma reserva numa loja).

::: warning
Os pins impedem que um usuário crie linhas atribuídas a outra pessoa e que mova uma linha para outro tenant. Desligue um deles só por um motivo concreto, e faça você mesmo o pin da coluna certa.
:::

## Erros {#errors}

Lançados como `Error` com mensagem `[AccessNexus]` (a CLI reporta `SCHEMA_INVALID`).

Em `definePermissions(...)`:

| Condição | Mensagem |
| --- | --- |
| Um recurso usa `{ scope: 'tenant' }` (diretamente ou dentro de `{ any }`) e falta `tenant` | `Some resources use { scope: 'tenant' } but no tenant config was provided` |
| Uma role num array de roles ou em `roles` de tenant não está em `roles` | `Unknown role "<role>" in <resource>.<action>. Available roles: ...` |

Em `policiesFor(...)` / `can(...)`:

| Condição | Mensagem |
| --- | --- |
| Recurso desconhecido | `Resource "<name>" not found in permissions. Available: ...` |
| `can()` para uma ação sem nível | `No permission defined for <resource>.<action>` |
| `'own'` sem `ownerColumn` | `Permission level 'own' requires ownerColumn to be set on the resource` |
| `{ scope: 'tenant' }` sem `tenant` | `Permission level { scope: 'tenant' } requires a tenant config in definePermissions()` |
| `{ scope: 'tenant' }` sem `tenantColumn` | `Permission level { scope: 'tenant' } requires tenantColumn to be set on the resource` |
| `roles` de tenant sem `tenant.roleColumn` | `Tenant-scoped roles require tenant.roleColumn to be defined` |

## PermissionsDef

O objeto retornado por `definePermissions`.

```ts
interface PermissionsDef<R extends string = string> {
  readonly roles: readonly string[];
  readonly tenant: TenantConfig | undefined;
  readonly resources: Readonly<Record<R, ResourcePermissions>>;
  can(resource: R, action: 'read' | 'create' | 'update' | 'delete'): PolicyRule;
  policiesFor(resource: R): TablePolicies;
}
```

| Membro | Retorna | Descrição |
| --- | --- | --- |
| `roles` | `readonly string[]` | Cópia congelada de `input.roles`. |
| `tenant` | `TenantConfig \| undefined` | `input.tenant`. |
| `resources` | `Readonly<Record<R, ResourcePermissions>>` | `input.resources`, congelado. |
| `policiesFor(resource)` | `TablePolicies` | `{ select, insert, update, delete }` para toda ação que tem nível (`read` vira `select`, `create` vira `insert`). Atribua ao `policies` de uma tabela. |
| `can(resource, action)` | `PolicyRule` | A regra de uma ação, com os pins de escrita incluídos. Lança erro quando a ação não tem nível. |

`can` é útil para combinar uma permissão com outras regras:

```ts
import { definePermissions, policy } from 'accessnexus';

const permissions = definePermissions({
  roles: ['admin'],
  resources: {
    posts: { ownerColumn: 'author_id', read: 'public', create: '*', update: 'own', delete: ['admin'] },
  },
});

export const policies = {
  ...permissions.policiesFor('posts'),
  update: policy.all([permissions.can('posts', 'update'), policy.custom('locked = false')]),
};
```

## Tipos {#types}

Todos exportados de `accessnexus`: `PermissionsInput`, `PermissionsDef`, `ResourcePermissions`, `TenantConfig`, `PermissionLevel`, `TenantScope`, `AnyPermission`.
