# Exemplos

Schemas completos para padrões de acesso comuns. Cada um é um `accessnexus.schema.ts` inteiro: copie, rode `npx accessnexus validate` e depois `diff` e `generate`. Eles seguem as [regras que você não pode quebrar](/pt/guide/security#rules-you-must-not-break).

## Tabela só do dono {#owner-only-table}

Cada usuário vê e edita só as próprias linhas.

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table, trigger } from 'accessnexus';

export default defineSchema({
  notes: table({
    columns: {
      id: 'uuid',
      user_id: 'uuid',
      body: 'text',
      created_at: { type: 'timestamptz', default: 'now()' },
      updated_at: 'timestamptz?',
    },
    primaryKey: 'id',
    references: { user_id: 'auth.users.id' },
    indexes: [{ columns: ['user_id'] }],
    triggers: [trigger.updatedAt('updated_at')],
    policies: {
      select: policy.isOwner('user_id'),
      insert: policy.isOwner('user_id'),
      update: policy.isOwner('user_id'),
      delete: policy.isOwner('user_id'),
    },
  }),
});
```

## Leitura pública, escrita autenticada {#public-read-authenticated-write}

Visitantes anônimos leem as linhas publicadas; só o autor escreve. A regra de `select` tem um ramo que não precisa de usuário, então a policy dela é concedida `TO public`.

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table } from 'accessnexus';

export default defineSchema({
  articles: table({
    columns: { id: 'uuid', author_id: 'uuid', title: 'text', published: 'boolean' },
    primaryKey: 'id',
    references: { author_id: 'auth.users.id' },
    policies: {
      select: policy.any([policy.custom('published = true'), policy.isOwner('author_id')]),
      insert: policy.isOwner('author_id'), // logado E escrevendo como si mesmo
      update: policy.isOwner('author_id'),
      delete: policy.isOwner('author_id'),
    },
  }),
});
```

::: warning Atenção
Não "resolva" um problema de leitura com `select: policy.public()`: isso também expõe os rascunhos.
:::

## Multi-tenant com roles (times) {#multi-tenant-with-roles-teams}

As roles ficam na tabela de membership. O criador de um time vira o primeiro owner por um trigger AFTER INSERT `security: 'definer'`, nunca por uma regra de INSERT em `team_members` (um criador removido poderia repeti-la). Owners adicionam qualquer pessoa; editors adicionam só membros comuns.

```ts [accessnexus.schema.ts]
import { definePermissions, defineSchema, policy, table, trigger } from 'accessnexus';

const permissions = definePermissions({
  roles: ['owner', 'editor', 'member'],
  tenant: { table: 'team_members', userColumn: 'user_id', tenantColumn: 'team_id', roleColumn: 'role' },
  resources: {
    teams: {
      ownerColumn: 'created_by',
      tenantColumn: 'id',                          // a linha É o tenant
      read: { any: ['own', { scope: 'tenant' }] },  // o criador a vê antes de entrar
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

/** O usuário atual é membro do time da linha (opcionalmente com uma das `roles`). */
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
    triggers: [trigger.lockColumns({ columns: ['team_id', 'user_id'] })],
    policies: {
      // As próprias linhas também: INSERT ... RETURNING precisa ver a linha nova
      select: policy.any([teamMember(), policy.isOwner('user_id')]),
      insert: policy.any([
        teamMember(['owner']),                                                  // owners adicionam qualquer pessoa
        policy.all([teamMember(['editor']), policy.custom("role = 'member'")]), // editors adicionam só membros
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

Aqui os owners adicionam pessoas diretamente, o que só é aceitável porque co-membros não veem nada pessoal uns dos outros. Se puderem ver, use convites (próxima receita).

## Membership por convite (consentimento) {#invitation-based-membership-consent}

Quando colegas de org conseguem ler os perfis uns dos outros, ninguém pode ser adicionado a uma org sem concordar. As memberships só são criadas pelo trigger do owner e pela `accept_invitation`, que checa o email convidado e confirmado. `org_members.insert` é `policy.none()`.

```ts [accessnexus.schema.ts]
import { defineSchema, policy, rpc, table, trigger } from 'accessnexus';

function orgMember(roles?: string[]) {
  return policy.belongsTo('org_id', {
    table: 'org_members', foreignKey: 'org_id', localKey: 'user_id',
    ...(roles ? { where: { role: roles } } : {}),
  });
}
const orgAdmin = policy.belongsTo('id', {
  table: 'org_members', foreignKey: 'org_id', localKey: 'user_id', where: { role: ['admin'] },
});

export default defineSchema({
  orgs: table({
    columns: { id: 'uuid', name: 'text', owner_id: 'uuid' },
    primaryKey: 'id',
    references: { owner_id: 'auth.users.id' },
    triggers: [
      trigger.custom({
        name: 'add_owner_as_admin',
        events: ['after_insert'],
        security: 'definer',
        functionBody: "INSERT INTO public.org_members (org_id, user_id, role) VALUES (NEW.id, NEW.owner_id, 'admin'); RETURN NEW;",
      }),
      trigger.lockColumns({ columns: ['owner_id'] }),
    ],
    policies: {
      select: policy.any([
        policy.belongsTo('id', { table: 'org_members', foreignKey: 'org_id', localKey: 'user_id' }),
        policy.isOwner('owner_id'), // INSERT ... RETURNING roda antes de a membership do trigger existir
      ]),
      insert: policy.isOwner('owner_id'),
      update: orgAdmin,
      delete: orgAdmin,
    },
  }),
  org_members: table({
    columns: { id: 'uuid', org_id: 'uuid', user_id: 'uuid', role: "enum('admin','member')" },
    primaryKey: 'id',
    references: { org_id: 'orgs.id', user_id: 'auth.users.id' },
    onDelete: { org_id: 'cascade' },
    indexes: [{ columns: ['org_id', 'user_id'], unique: true }],
    triggers: [trigger.lockColumns({ columns: ['org_id', 'user_id'] })],
    policies: {
      select: policy.any([orgMember(), policy.isOwner('user_id')]),
      insert: policy.none(), // consentimento: só o trigger do owner e accept_invitation adicionam membros
      update: orgMember(['admin']),
      delete: policy.any([orgMember(['admin']), policy.isOwner('user_id')]),
    },
  }),
  invitations: table({
    columns: {
      id: 'uuid',
      org_id: 'uuid',
      email: 'text',
      role: "enum('admin','member')",
      invited_by: 'uuid',
      token: { type: 'text', unique: true, default: 'gen_random_uuid()::text' },
      expires_at: { type: 'timestamptz', default: "now() + interval '7 days'" },
      accepted_at: 'timestamptz?',
    },
    primaryKey: 'id',
    references: { org_id: 'orgs.id', invited_by: 'auth.users.id' },
    onDelete: { org_id: 'cascade' },
    policies: {
      select: policy.any([
        policy.custom("email = ((SELECT auth.jwt()) ->> 'email')"), // o convidado
        orgMember(['admin']),
      ]),
      insert: policy.all([orgMember(['admin']), policy.isOwner('invited_by')]),
      update: policy.none(), // aceito só via accept_invitation
      delete: orgMember(['admin']),
    },
  }),
}, {
  rpcs: {
    accept_invitation: rpc({
      args: { p_token: 'text' },
      returns: 'uuid',
      security: 'definer',
      body: `
        DECLARE
          v_inv public.invitations%ROWTYPE;
          v_member_id uuid;
        BEGIN
          IF (SELECT auth.uid()) IS NULL THEN
            RAISE EXCEPTION 'Sign in to accept an invitation' USING ERRCODE = '42501';
          END IF;
          SELECT * INTO v_inv FROM public.invitations
            WHERE token = p_token AND accepted_at IS NULL AND expires_at > NOW();
          IF NOT FOUND THEN
            RAISE EXCEPTION 'Invalid or expired invitation';
          END IF;
          -- Only the invited address, and only once it is confirmed
          IF lower(v_inv.email) IS DISTINCT FROM lower((SELECT auth.jwt()) ->> 'email') THEN
            RAISE EXCEPTION 'This invitation was sent to another email address' USING ERRCODE = '42501';
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM auth.users u
            WHERE u.id = (SELECT auth.uid()) AND u.email_confirmed_at IS NOT NULL
          ) THEN
            RAISE EXCEPTION 'Confirm your email address first' USING ERRCODE = '42501';
          END IF;
          -- Each enum column has its own type: cast through text
          INSERT INTO public.org_members (org_id, user_id, role)
          VALUES (v_inv.org_id, (SELECT auth.uid()), v_inv.role::text::org_members_role_enum)
          RETURNING id INTO v_member_id;
          UPDATE public.invitations SET accepted_at = NOW() WHERE id = v_inv.id;
          RETURN v_member_id;
        END;`,
    }),
  },
});
```

O token sozinho não basta: a checagem do email barra um link vazado, e a checagem de confirmação barra alguém que se cadastrou com o endereço do convidado num projeto em que "Confirm email" está desligado.

## Filho de um recurso de tenant {#child-of-a-tenant-resource}

O RLS checa cada linha contra a própria coluna de tenant, e foreign keys são checadas sem RLS. Por isso `tasks` carrega o próprio `org_id`, e um trigger o mantém igual ao do projeto. Sem isso, um membro da org A consegue anexar uma task a um projeto da org B (`TENANT_PARENT_UNCHECKED`).

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table, trigger } from 'accessnexus';

const member = policy.belongsTo('org_id', { table: 'org_members', foreignKey: 'org_id', localKey: 'user_id' });
const memberPolicies = { select: member, insert: member, update: member, delete: member };

export default defineSchema({
  orgs: table({
    columns: { id: 'uuid', name: 'text' },
    primaryKey: 'id',
    policies: { select: policy.belongsTo('id', { table: 'org_members', foreignKey: 'org_id', localKey: 'user_id' }) },
  }),
  org_members: table({
    columns: { id: 'uuid', org_id: 'uuid', user_id: 'uuid', role: "enum('admin','member')" },
    primaryKey: 'id',
    references: { org_id: 'orgs.id', user_id: 'auth.users.id' },
    indexes: [{ columns: ['org_id', 'user_id'], unique: true }],
    policies: { select: policy.isOwner('user_id') }, // escritas: só service role / RPCs definer
  }),
  projects: table({
    columns: { id: 'uuid', org_id: 'uuid', name: 'text' },
    primaryKey: 'id',
    references: { org_id: 'orgs.id' },
    triggers: [trigger.lockColumns({ columns: ['org_id'] })],
    policies: memberPolicies,
  }),
  tasks: table({
    columns: { id: 'uuid', org_id: 'uuid', project_id: 'uuid', title: 'text' },
    primaryKey: 'id',
    references: { org_id: 'orgs.id', project_id: 'projects.id' },
    onDelete: { project_id: 'cascade' },
    triggers: [
      // Roda como o usuário que escreve: o projeto de outra org é invisível, então
      // é reportado exatamente como um projeto que não existe.
      trigger.custom({
        name: 'same_org_project',
        events: ['before_insert', 'before_update'],
        functionBody: `
          IF NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.id = NEW.project_id AND p.org_id = NEW.org_id) THEN
            RAISE EXCEPTION 'project % not found in org %', NEW.project_id, NEW.org_id USING ERRCODE = '23503';
          END IF;
          RETURN NEW;`,
      }),
      trigger.lockColumns({ name: 'lock_tenant', columns: ['org_id', 'project_id'] }),
    ],
    policies: memberPolicies,
  }),
});
```

O mesmo vale para níveis mais profundos (comments sob tasks checam `tasks.org_id`).

## Deixe o usuário mudar só algumas colunas {#let-a-user-change-only-some-columns}

O RLS decide quais linhas um usuário pode atualizar, nunca quais colunas. Trave o resto com `trigger.lockColumns`.

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table, trigger } from 'accessnexus';

export default defineSchema({
  tickets: table({
    columns: {
      id: 'uuid',
      org_id: 'uuid',
      reporter_id: 'uuid',
      assignee_id: 'uuid?',
      title: 'text',
      status: { type: "enum('open','doing','done')", default: "'open'" },
    },
    primaryKey: 'id',
    references: { reporter_id: 'auth.users.id', assignee_id: 'auth.users.id' },
    triggers: [
      // Ninguém reatribui um ticket nem o move para outra org
      trigger.lockColumns({ name: 'lock_identity', columns: ['reporter_id', 'org_id'] }),
      // O responsável só pode mudar o status; quem reportou pode mudar todo o resto
      trigger.lockColumns({
        name: 'assignee_scope',
        except: ['status'],
        unless: 'OLD.reporter_id = (SELECT auth.uid())',
      }),
    ],
    policies: {
      select: policy.any([policy.isOwner('reporter_id'), policy.isOwner('assignee_id')]),
      insert: policy.isOwner('reporter_id'),
      update: policy.any([policy.isOwner('reporter_id'), policy.isOwner('assignee_id')]),
      delete: policy.isOwner('reporter_id'),
    },
  }),
});
```

Mudar uma coluna travada lança SQLSTATE `42501`. Para uma alteração em várias etapas que precisa ficar consistente, prefira uma [RPC](/pt/guide/rpcs) definer.

## Audit log {#audit-log}

`trigger.auditLog` grava `(table_name, operation, old_data, new_data, changed_at)` a partir de uma função `SECURITY DEFINER`. A tabela de auditoria bloqueia inserts pela API, então as entradas não podem ser forjadas.

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table, trigger } from 'accessnexus';

export default defineSchema({
  invoices: table({
    columns: { id: 'uuid', owner_id: 'uuid', amount: 'decimal' },
    primaryKey: 'id',
    references: { owner_id: 'auth.users.id' },
    triggers: [trigger.auditLog({ table: 'audit_log' })],
    policies: {
      select: policy.isOwner('owner_id'),
      insert: policy.isOwner('owner_id'),
      update: policy.isOwner('owner_id'),
      delete: policy.none(),
    },
  }),
  audit_log: table({
    columns: {
      id: 'bigint',
      table_name: 'text',
      operation: 'text',
      old_data: 'jsonb?',
      new_data: 'jsonb?',
      changed_at: { type: 'timestamptz', default: 'now()' },
    },
    primaryKey: 'id',
    policies: {
      select: policy.hasRole('admin'), // equipe da plataforma (app_metadata.role)
      insert: policy.none(),           // só o trigger escreve
      update: policy.none(),           // só acréscimo
      delete: policy.none(),
    },
  }),
});
```

## Soft delete {#soft-delete}

`softDelete: 'deleted_at'` transforma o `DELETE` em `SET deleted_at = NOW()`, julgado pela policy de delete. Um guard impede que usuários da API definam ou limpem a coluna com um `UPDATE` comum. Linhas com soft delete continuam visíveis pelo RLS (só o SDK as filtra), então exclua-as no `select`. A restauração passa por uma RPC definer.

```ts [accessnexus.schema.ts]
import { defineSchema, policy, rpc, table } from 'accessnexus';

export default defineSchema({
  posts: table({
    columns: {
      id: 'uuid',
      author_id: 'uuid',
      title: 'text',
      published: { type: 'boolean', default: 'false' },
      deleted_at: 'timestamptz?',
    },
    primaryKey: 'id',
    references: { author_id: 'auth.users.id' },
    softDelete: 'deleted_at',
    policies: {
      select: policy.all([
        policy.custom('deleted_at IS NULL'),
        policy.any([policy.isOwner('author_id'), policy.custom('published = true')]),
      ]),
      insert: policy.isOwner('author_id'),
      update: policy.isOwner('author_id'),
      delete: policy.isOwner('author_id'),
    },
  }),
}, {
  rpcs: {
    restore_post: rpc({
      args: { p_id: 'uuid' },
      security: 'definer',
      body: `
        IF (SELECT auth.uid()) IS NULL THEN
          RAISE EXCEPTION 'sign in first' USING ERRCODE = '42501';
        END IF;
        UPDATE public.posts SET deleted_at = NULL
          WHERE id = p_id AND author_id = (SELECT auth.uid());`,
    }),
  },
});
```

Não combine `onDelete: 'cascade'` apontando para uma tabela com soft delete (`CASCADE_INTO_SOFT_DELETE`): use `'restrict'` e faça soft delete dos filhos antes.

## Veja também {#related}

- [Modelo de segurança](/pt/guide/security)
- [Policies](/pt/guide/policies), [Permissões](/pt/guide/permissions), [Triggers](/pt/guide/triggers), [RPCs](/pt/guide/rpcs)
- [Solução de problemas](/pt/guide/troubleshooting)
