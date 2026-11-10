# defineEnum / tenantInvitations

Blocos de construção para schemas multi-tenant: um enum do Postgres compartilhado por colunas e RPCs, e um jeito consensual de entrar num tenant. Os dois são exportados de `accessnexus`. Guias: [Permissões e tenants](/pt/guide/permissions) e [Exemplos](/pt/guide/cookbook#invitation-based-membership-consent). Um schema completo que usa os dois acompanha o repositório em `examples/saas-teams/`.

```ts
import { defineEnum, tenantInvitations } from 'accessnexus';
```

## defineEnum {#defineenum}

Declara um enum do Postgres que várias colunas e RPCs compartilham. Tipos `enum('a','b')` por coluna criam um tipo do Postgres por coluna, então comparar dois deles exige casts via text; um enum compartilhado é um único `CREATE TYPE`.

```ts
defineEnum<const TValues extends readonly string[]>(name: string, values: TValues): EnumDef<TValues>;

interface EnumDef<TValues extends readonly string[] = readonly string[]> {
  readonly name: string;
  readonly values: TValues;
  readonly type: `enum:${string}`;      // 'enum:<name>'
  readonly nullable: `enum:${string}?`; // 'enum:<name>?'
}
```

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `name` | `string` | Nome do tipo no Postgres, em snake_case minúsculo. |
| `values` | `readonly string[]` | Os valores do enum, em ordem. |

Usar leva dois passos:

1. Registre-o: `defineSchema(tables, { enums: [role] })` ([`options.enums`](/pt/api/schema#defineschema)). Um nome usado mas não declarado é `UNKNOWN_ENUM`.
2. Use `role.type` (ou `role.nullable`) como tipo de coluna, tipo de `args` de RPC ou tipo de `returns.table`.

O que ele gera e como tipa:

| Onde | Resultado |
| --- | --- |
| Migration | Um `CREATE TYPE <name> AS ENUM (...)` idempotente antes das tabelas, compartilhado por todos os usos. |
| Coluna | `role: { type: memberRole.type, default: "'member'" }` é uma coluna do tipo `<name>`. O `default` é SQL cru, então o literal mantém as próprias aspas. |
| RPC | `args: { p_role: memberRole.type }` e `returns: { table: { role: memberRole.type } }`. Um tipo de RPC também pode ser `'table.column'` (o tipo daquela coluna, união do enum incluída). |
| SDK | Os valores como união, e `Database['public']['Enums'][<name>]`. |

```ts
import { defineEnum, defineSchema, policy, rpc, table } from 'accessnexus';

export const memberRole = defineEnum('member_role', ['owner', 'admin', 'member', 'viewer']);

export default defineSchema({
  org_members: table({
    columns: { id: 'uuid', org_id: 'uuid', user_id: 'uuid', role: { type: memberRole.type, default: "'member'" } },
    primaryKey: 'id',
    policies: { select: policy.isOwner('user_id') },
  }),
}, {
  enums: [memberRole],
  rpcs: {
    members_with_role: rpc({
      args: { p_org: 'uuid', p_role: memberRole.type },
      returns: { table: { user_id: 'uuid', role: memberRole.type } },
      language: 'sql',
      volatility: 'stable',
      body: 'SELECT user_id, role FROM public.org_members WHERE org_id = p_org AND role = p_role;',
    }),
  },
});
```

## tenantInvitations {#tenantinvitations}

Convites para um tenant (uma org, um time, um workspace): o jeito consensual de adicionar um membro. Retorna uma tabela e duas RPCs para espalhar no `defineSchema`.

```ts
tenantInvitations(options: TenantInvitationsOptions): {
  table: TableDef;
  rpcs: Record<string, RpcDef>;
  tableName: string;
};
```

### Opções {#options}

| Opção | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `tenant` | `{ table, userColumn, tenantColumn, roleColumn }` | obrigatório | A tabela de membership, como no [`definePermissions`](/pt/api/permissions#tenantconfig); aqui o `roleColumn` é obrigatório. |
| `tenantTable` | `string` | obrigatório | A tabela de tenant a que os convites pertencem: o alvo da foreign key (primary key `id`). |
| `tenantNameColumn` | `string` | `undefined` | Coluna de `tenantTable` que o `my_invitations` mostra como `tenant_name`, por exemplo `'name'`. Sem ela o resultado não tem `tenant_name`. |
| `tenantNameAlias` | `string` | `'tenant_name'` | Nome dessa coluna no resultado do `my_invitations`, por exemplo `'org_name'` para manter o formato de uma RPC que o app já lê (um resultado alterado é o risco `function_result_changed` do plano). |
| `roles` | `EnumDef` ou `readonly string[]` | obrigatório | Papéis que um convite pode carregar: um [`defineEnum`](#defineenum) compartilhado (também o tipo da coluna de papel do membership) ou uma lista de valores. |
| `inviterRoles` | `Record<string, readonly string[]>` | obrigatório | Quais papéis podem convidar, e quais papéis cada um pode conceder: `{ owner: ['admin', 'member', 'viewer'], admin: ['member', 'viewer'] }`. |
| `roleType` | `string` | o enum compartilhado, ou `<tenant.table>_<roleColumn>_enum` | Tipo SQL da coluna de papel do membership, usado no cast do papel ao entrar. |
| `requireConfirmedEmail` | `boolean` | `true` | Aceitar exige um e-mail confirmado em `auth.users`. |
| `table` | `string` | `'invitations'` | Nome da tabela de convites. |
| `rpcNames` | `{ accept?: string; mine?: string }` | `accept_invitation` / `my_invitations` | Nomes das duas RPCs. |

O último papel de `roles` (o mais baixo, por convenção) é o default da coluna `role`.

### A tabela {#the-table}

`invitations(id, <tenantColumn>, email, role, invited_by, created_at)`, com a coluna de tenant nomeada como `tenant.tenantColumn`:

| Coluna | Tipo | Notas |
| --- | --- | --- |
| `id` | `uuid` | Primary key. |
| `<tenantColumn>` | `uuid` | Referencia `<tenantTable>.id`, `ON DELETE CASCADE`. |
| `email` | `text` | Check: minúsculo e com formato de e-mail. Único por tenant. |
| `role` | o enum de `roles` | O papel com que o convidado entra. |
| `invited_by` | `uuid` | Referencia `auth.users.id`, `ON DELETE CASCADE`. |
| `created_at` | `timestamptz` | Default `now()`. |

Índices: único `(<tenantColumn>, email)` e `(email)`. Policies:

| Operação | Quem |
| --- | --- |
| `select` | Os convidadores (membros do tenant cujo papel é uma chave de `inviterRoles`) e o convidado (o e-mail do JWT bate com `email`). |
| `insert` | Um convidador, em nome próprio (`invited_by` é quem chama) e só para os papéis que a entrada dele em `inviterRoles` permite. |
| `update` | Ninguém. Um convite nunca é editado. |
| `delete` | Os convidadores (revogar) e o convidado (recusar). |

### As RPCs {#the-rpcs}

| RPC | Segurança | Assinatura | Comportamento |
| --- | --- | --- | --- |
| `accept_invitation` | definer | `(p_invitation uuid) => uuid` | Quem chama precisa estar logado, ter e-mail confirmado (a menos que `requireConfirmedEmail: false`) e bater com o e-mail do convite. Entra no tenant com o papel convidado (nada é inserido se já for membro), o convite é consumido e o id do tenant é retornado. |
| `my_invitations` | definer, stable | `() => table` | Os convites de quem chama: `{ id, <tenantColumn>, tenant_name?, role, created_at }`, do mais antigo ao mais novo. Existe porque o convidado ainda não consegue ler o tenant, então o nome precisa vir de uma função definer. |

As duas RPCs têm `REVOKE` de `PUBLIC` e `anon`, como toda RPC `security: 'definer'`.

| Erro | SQLSTATE | Quando |
| --- | --- | --- |
| `sign in first` | `42501` | `accept_invitation` chamada sem usuário (anon). |
| `confirm your e-mail first` | `42501` | O e-mail do usuário não está confirmado (`auth.users.email_confirmed_at`). |
| `invitation not found` | `P0002` | O id não existe, ou o convite é para outro e-mail. |

```ts
import { defineEnum, defineSchema, policy, table, tenantInvitations } from 'accessnexus';

export const memberRole = defineEnum('member_role', ['owner', 'admin', 'member', 'viewer']);

const invites = tenantInvitations({
  tenant: { table: 'org_members', userColumn: 'user_id', tenantColumn: 'org_id', roleColumn: 'role' },
  tenantTable: 'orgs',
  tenantNameColumn: 'name',
  roles: memberRole,
  inviterRoles: { owner: ['admin', 'member', 'viewer'], admin: ['member', 'viewer'] },
});

export default defineSchema({
  orgs: table({ columns: { id: 'uuid', name: 'text' }, primaryKey: 'id', policies: { select: policy.isAuthenticated() } }),
  org_members: table({
    columns: { id: 'uuid', org_id: 'uuid', user_id: 'uuid', role: { type: memberRole.type, default: "'member'" } },
    primaryKey: 'id',
    references: { org_id: 'orgs.id', user_id: 'auth.users.id' },
    indexes: [{ columns: ['org_id', 'user_id'], unique: true }],
    policies: { select: policy.isOwner('user_id'), insert: policy.none() },
  }),
  invitations: invites.table,
}, { enums: [memberRole], rpcs: { ...invites.rpcs } });
```

A tabela de membership mantém `insert: policy.none()`: as pessoas entram só por `accept_invitation`, e é isso que torna a entrada consensual. No app:

```ts
const { data: pending } = await db.rpc.my_invitations();   // [{ id, org_id, tenant_name, role, created_at }]
const { data: orgId } = await db.rpc.accept_invitation({ p_invitation: pending![0].id });
```

Regras mais finas (limite de assentos, domínios de e-mail permitidos) pedem uma tabela própria ou uma RPC que envolva estas.
