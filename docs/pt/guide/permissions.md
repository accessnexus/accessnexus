# Permissões {#permissions}

`definePermissions` é um mapa central de acesso baseado em papéis. Você declara seus papéis e o modelo de tenant uma única vez, descreve quem pode ler, criar, atualizar e excluir cada recurso e associa o resultado às tabelas com `policiesFor`. Ele compila para os mesmos [builders de policy](/pt/guide/policies), com pins de escrita seguros adicionados para você.

Use quando várias tabelas compartilham o mesmo modelo de acesso, tipicamente um app multi-tenant em que os usuários pertencem a organizações, times ou workspaces.

## Um primeiro exemplo {#a-first-example}

```ts [accessnexus.schema.ts]
import { definePermissions, defineSchema, table } from 'accessnexus';

const permissions = definePermissions({
  roles: ['admin', 'manager', 'member'],
  tenant: { table: 'org_members', userColumn: 'user_id', tenantColumn: 'org_id', roleColumn: 'role' },
  resources: {
    projects: {
      ownerColumn: 'created_by',
      tenantColumn: 'org_id',
      read: { scope: 'tenant' },                                   // qualquer membro da org
      create: { scope: 'tenant', roles: ['admin', 'manager'] },     // + created_by = auth.uid()
      update: { any: ['own', { scope: 'tenant', roles: ['admin'] }] }, // + continua numa org da qual você faz parte
      delete: { scope: 'tenant', roles: ['admin'] },
    },
  },
});

export default defineSchema({
  projects: table({
    columns: { id: 'uuid', org_id: 'uuid', created_by: 'uuid', name: 'text' },
    primaryKey: 'id',
    references: { created_by: 'auth.users.id' },
    policies: permissions.policiesFor('projects'),
  }),
});
```

Um schema real também declara `orgs` e `org_members`; veja o [passo a passo](#multi-tenant-walkthrough) abaixo.

## Entrada {#input}

| Campo | Descrição |
| --- | --- |
| `roles` | Todo nome de papel usado em qualquer lugar de `resources`. Um papel desconhecido lança erro quando o schema é carregado |
| `tenant` | A tabela de membros. Obrigatória assim que um recurso usa `{ scope: 'tenant' }` |
| `resources` | Uma entrada por nome de tabela, com suas colunas e um nível por ação |

### `tenant`

| Campo | Descrição |
| --- | --- |
| `table` | Tabela de membros, por exemplo `'org_members'` |
| `userColumn` | A coluna dela com o id do usuário, por exemplo `'user_id'` |
| `tenantColumn` | A coluna dela com o id do tenant, por exemplo `'org_id'` |
| `roleColumn` | A coluna dela com o papel do membro. Obrigatória para `{ scope: 'tenant', roles }` |

### Recursos {#resources}

| Campo | Descrição |
| --- | --- |
| `ownerColumn` | Coluna com o id do usuário dono. Obrigatória para `'own'` |
| `tenantColumn` | Coluna com o id do tenant da linha. Obrigatória para `{ scope: 'tenant' }`. Use `'id'` quando a linha é o próprio tenant |
| `read`, `create`, `update`, `delete` | Um nível de permissão por ação. Uma ação omitida é negada |
| `pinOwnerOnCreate` | Ligado por padrão. Veja [Pins de escrita](#write-pins) |
| `pinTenant` | Ligado por padrão. Veja [Pins de escrita](#write-pins) |

As ações mapeiam para operações de policy: `read` → `select`, `create` → `insert`, `update` → `update`, `delete` → `delete`.

## Níveis de permissão {#permission-levels}

| Nível | Quem | Compila para |
| --- | --- | --- |
| `'public'` | Todo mundo, incluindo visitantes anônimos | `policy.public()` |
| `'*'` | Qualquer usuário logado | `policy.isAuthenticated()` |
| `'none'` | Ninguém pela API | `policy.none()` |
| `'own'` | O dono da linha | `policy.isOwner(ownerColumn)` |
| `{ scope: 'tenant' }` | Qualquer membro do tenant da linha | `policy.belongsTo(tenantColumn, { through: tenant })` |
| `{ scope: 'tenant', roles: ['admin'] }` | Um membro do tenant da linha com um desses papéis | Igual, filtrado por `roleColumn` |
| `['admin']` | Usuários com esse papel **global** do app (JWT `app_metadata.role`) | `policy.hasRole('admin')`, com OR para vários papéis |
| `{ any: [...] }` | Qualquer um dos níveis listados | `policy.any([...])` |

::: danger `'public'` e `'*'` em escritas
`create: 'public'` permite que qualquer pessoa com a anon key insira linhas. `'*'` permite que qualquer conta faça isso, e qualquer um pode se cadastrar. Prefira um escopo de tenant, ou mantenha o pin de dono ligado (o padrão) para que `'*'` pelo menos signifique "criar linhas atribuídas a você mesmo".
:::

## Papéis globais vs papéis de tenant {#global-roles-vs-tenant-roles}

São duas coisas diferentes, e confundi-las é uma brecha comum.

| | Papel de tenant | Papel global |
| --- | --- | --- |
| Significa | "Admin **desta org**" | "Equipe da nossa plataforma" |
| Armazenado em | A `roleColumn` da tabela de membros | A claim `app_metadata.role` do JWT |
| Definido por | Quem pode escrever na tabela de membros (conforme suas policies) | Só o servidor: `supabase.auth.admin.updateUserById(id, { app_metadata: { role: 'admin' } })` ou um custom access token hook |
| Nível | `{ scope: 'tenant', roles: ['admin'] }` | `['admin']` |
| Builder | `policy.belongsTo(col, { ..., where: { role: ['admin'] } })` | `policy.hasRole('admin')` |

Um array puro como `['admin']` **não** é um admin da org: qualquer usuário com `app_metadata.role = 'admin'` passa nele, em todas as orgs. O `validate` emite o aviso `GLOBAL_ROLE_IN_TENANT_TABLE` quando uma tabela mistura os dois tipos.

## Pins de escrita {#write-pins}

`create` e `update` recebem condições extras sobre a linha escrita, ligadas por padrão. Elas barram os dois ataques multi-tenant clássicos: criar linhas em nome de outra pessoa e mover uma linha para outro tenant.

| Pin | Aplica-se a | Adiciona ao `WITH CHECK` | Desligue com |
| --- | --- | --- | --- |
| Pin de dono | `create`, quando `ownerColumn` está definido e o nível não é `'public'`, `'none'` ou `'own'` | `ownerColumn = (SELECT auth.uid())` | `pinOwnerOnCreate: false` |
| Pin de tenant | `update`, e `create` quando seu nível ainda não tem escopo de tenant; nunca níveis `'public'` / `'none'`, nunca `create` quando `tenantColumn` é `'id'` | O usuário é membro do (novo) tenant da linha | `pinTenant: false` |

O recurso `projects` acima compila para estas policies de insert e update (funções auxiliares omitidas; `_1_fn` verifica a associação, `_2_fn` admin ou manager, `_3_fn` admin):

```sql
CREATE POLICY "accessnexus_projects_insert"
  ON projects FOR INSERT
  TO authenticated
  WITH CHECK (
    ((SELECT accessnexus_projects_belongs_to_2_fn(org_id)))
    AND ((SELECT auth.uid()) = created_by)
  );

CREATE POLICY "accessnexus_projects_update"
  ON projects FOR UPDATE
  TO authenticated
  USING (
    ((SELECT auth.uid()) = created_by)
    OR ((SELECT accessnexus_projects_belongs_to_3_fn(org_id)))
  )
  WITH CHECK (
    (((SELECT auth.uid()) = created_by)
    OR ((SELECT accessnexus_projects_belongs_to_3_fn(org_id))))
    AND ((SELECT accessnexus_projects_belongs_to_1_fn(org_id)))
  );
```

Sem o pin de tenant, quem criou um projeto (`'own'`) poderia atualizar seu `org_id` para uma org da qual não faz parte.

### Quando desligar um pin {#when-to-turn-a-pin-off}

Só por um motivo concreto, e aí fixe você mesmo a coluna certa:

- **`pinOwnerOnCreate: false`** quando outra pessoa atribui a coluna de dono, por exemplo um manager criando uma tarefa cuja `ownerColumn` é `assignee_id`. Para ainda registrar quem realmente criou, adicione uma coluna `created_by` e fixe-a você mesmo: `insert: policy.withCheck(permissions.can('tasks', 'create'), policy.isOwner('created_by'))`.
- **`pinTenant: false`** para recursos escritos por quem não é membro, por exemplo clientes fazendo reservas numa loja:

```ts
import { definePermissions } from 'accessnexus';

export const permissions = definePermissions({
  roles: ['admin', 'member'],
  tenant: { table: 'shop_members', userColumn: 'user_id', tenantColumn: 'shop_id', roleColumn: 'role' },
  resources: {
    bookings: {
      ownerColumn: 'client_id',
      tenantColumn: 'shop_id',
      pinTenant: false,                             // clientes não são membros da loja
      read: { any: ['own', { scope: 'tenant' }] },  // o cliente e a equipe da loja
      create: '*',                                  // + client_id = auth.uid() (o pin de dono continua ligado)
      update: 'own',
      delete: { scope: 'tenant', roles: ['admin'] },
    },
  },
});
```

## `policiesFor` e `can` {#policiesfor-and-can}

```ts
import { definePermissions, policy } from 'accessnexus';

export const permissions = definePermissions({
  roles: ['owner', 'editor', 'viewer'],
  tenant: { table: 'team_members', userColumn: 'user_id', tenantColumn: 'team_id', roleColumn: 'role' },
  resources: {
    documents: {
      ownerColumn: 'created_by',
      tenantColumn: 'team_id',
      read: { scope: 'tenant' },
      create: { scope: 'tenant', roles: ['owner', 'editor'] },
      update: { any: ['own', { scope: 'tenant', roles: ['owner'] }] },
      delete: { scope: 'tenant', roles: ['owner'] },
    },
  },
});

// Todas as ações declaradas, como as `policies` de uma tabela
export const documentPolicies = permissions.policiesFor('documents');

// Uma regra só, para combinar com outros builders
export const readable = policy.any([permissions.can('documents', 'read'), policy.custom('shared = true')]);
```

| Método | Retorna | Observações |
| --- | --- | --- |
| `policiesFor(resource)` | `{ select?, insert?, update?, delete? }` | Ações que você não declarou ficam de fora, então são negadas |
| `can(resource, action)` | Uma regra de policy, com pins | Lança erro quando a ação não foi declarada |

Ambos aceitam só nomes de recursos declarados: `policiesFor('documnets')` é um erro de tipo.

## Passo a passo multi-tenant {#multi-tenant-walkthrough}

Um workspace de times: usuários criam times, quem cria vira o primeiro owner, owners gerenciam os membros e projetos pertencem a um time.

```ts [accessnexus.schema.ts]
import { definePermissions, defineSchema, policy, table, trigger } from 'accessnexus';

const permissions = definePermissions({
  roles: ['owner', 'editor', 'member'],
  tenant: { table: 'team_members', userColumn: 'user_id', tenantColumn: 'team_id', roleColumn: 'role' },
  resources: {
    teams: {
      ownerColumn: 'created_by',
      tenantColumn: 'id',                          // a linha É o tenant
      read: { any: ['own', { scope: 'tenant' }] },  // quem criou vê antes de entrar
      create: '*',                                  // + created_by = auth.uid()
      update: { scope: 'tenant', roles: ['owner'] },
      delete: { scope: 'tenant', roles: ['owner'] },
    },
    projects: {
      ownerColumn: 'created_by',
      tenantColumn: 'team_id',
      read: { scope: 'tenant' },
      create: { scope: 'tenant', roles: ['owner', 'editor'] },
      update: { any: ['own', { scope: 'tenant', roles: ['owner'] }] },
      delete: { scope: 'tenant', roles: ['owner'] },
    },
  },
});

/** O usuário atual é membro do time da linha (opcionalmente com um dos `roles`). */
function teamMember(roles?: string[]) {
  return policy.belongsTo('team_id', {
    table: 'team_members', foreignKey: 'team_id', localKey: 'user_id',
    ...(roles ? { where: { role: roles } } : {}),
  });
}

export default defineSchema({
  teams: table({
    columns: { id: 'uuid', name: 'text', created_by: 'uuid' },
    primaryKey: 'id',
    references: { created_by: 'auth.users.id' },
    triggers: [
      // Quem cria vira o primeiro owner (roda como dono da tabela, ignorando RLS)
      trigger.custom({
        name: 'add_creator_as_owner',
        events: ['after_insert'],
        security: 'definer',
        functionBody: "INSERT INTO public.team_members (team_id, user_id, role) VALUES (NEW.id, NEW.created_by, 'owner'); RETURN NEW;",
      }),
      trigger.lockColumns({ columns: ['created_by'] }),
    ],
    policies: permissions.policiesFor('teams'),
  }),
  team_members: table({
    columns: { id: 'uuid', team_id: 'uuid', user_id: 'uuid', role: "enum('owner','editor','member')" },
    primaryKey: 'id',
    references: { team_id: 'teams.id', user_id: 'auth.users.id' },
    onDelete: { team_id: 'cascade' },
    indexes: [{ columns: ['team_id', 'user_id'], unique: true }],
    triggers: [trigger.lockColumns({ columns: ['team_id', 'user_id'] })], // owners só mudam papéis
    policies: {
      // As próprias linhas também: INSERT ... RETURNING precisa ver a linha nova
      select: policy.any([teamMember(), policy.isOwner('user_id')]),
      insert: policy.any([
        teamMember(['owner']),                                                  // owners adicionam qualquer um
        policy.all([teamMember(['editor']), policy.custom("role = 'member'")]), // editors adicionam só members
      ]),
      update: teamMember(['owner']),
      delete: policy.any([teamMember(['owner']), policy.isOwner('user_id')]),  // owners removem, qualquer um sai
    },
  }),
  projects: table({
    columns: { id: 'uuid', team_id: 'uuid', created_by: 'uuid', name: 'text' },
    primaryKey: 'id',
    references: { team_id: 'teams.id', created_by: 'auth.users.id' },
    onDelete: { team_id: 'cascade' },
    triggers: [trigger.lockColumns({ columns: ['created_by', 'team_id'] })],
    policies: permissions.policiesFor('projects'),
  }),
});
```

O que cada parte faz:

1. **`teams`** é o próprio tenant (`tenantColumn: 'id'`). Qualquer usuário logado pode criar um, mas só em nome próprio (pin de dono). `read` inclui `'own'` porque o `create` do SDK retorna a linha nova, e esse `INSERT ... RETURNING` é verificado antes de a linha de associação existir.
2. **O primeiro owner** é adicionado por um trigger `AFTER INSERT` com `security: 'definer'`, e não por uma regra de INSERT em `team_members`. Uma regra como "quem criou pode se adicionar como owner" continua válida para sempre, então um criador removido pelos outros owners poderia repeti-la para voltar.
3. **`team_members`** é escrita pelos owners, e editors só podem adicionar membros comuns. Ninguém consegue conceder um papel acima do seu.
4. **`lockColumns`** mantém fixos a quem e a onde uma linha pertence. RLS não restringe colunas, então sem isso um owner poderia reescrever `team_id` ou `user_id` numa linha de associação.
5. **`projects`** segue o mapa de permissões; os pins mantêm `created_by` honesto e impedem que um projeto seja movido para um time do qual o usuário não faz parte.

Fluxo no app: `db.teams.create({ name, created_by: user.id })` torna o usuário um owner; depois os owners adicionam pessoas com `db.team_members.create({ team_id, user_id, role })`.

::: warning Visibilidade derivada de compartilhar um tenant exige consentimento
Se membros do mesmo time podem ler dados pessoais uns dos outros (um perfil com nome e e-mail), adicionar alguém a um time precisa exigir o consentimento dessa pessoa. Do contrário, qualquer um pode criar um time, adicionar um desconhecido pelo id de usuário e ler os dados dele como "colega de time". Nesse caso, defina o `insert` da tabela de membros como `policy.none()` e adicione pessoas só por meio de um convite aceito, por exemplo uma RPC `security: 'definer'` que verifica o e-mail convidado e confirmado. Veja o [Cookbook](/pt/guide/cookbook).
:::

::: tip Linhas filhas precisam de uma proteção de mesmo tenant
O RLS verifica cada linha contra sua própria coluna de tenant, e foreign keys são verificadas sem RLS. Uma linha de `tasks` com seu próprio `team_id` que aponta para um projeto de outro time passa nas duas verificações. Adicione um trigger de proteção que verifica o tenant do pai; o `validate` emite o aviso `TENANT_PARENT_UNCHECKED` quando ele falta. O padrão está no [Cookbook](/pt/guide/cookbook).
:::

## Próximos passos {#next-steps}

- [Policies](/pt/guide/policies) - os builders para os quais as permissões compilam
- [Triggers](/pt/guide/triggers) - `lockColumns` e triggers definer usados acima
- [Cookbook](/pt/guide/cookbook) - convites, recursos filhos, updates restritos a colunas
- [API de permissões](/pt/api/permissions) - tipos completos
