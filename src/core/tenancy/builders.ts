// ============================================
// AccessNexus - Multi-tenant building blocks
// Invitations: the consent-based way into a tenant
// ============================================

import { policy } from '../policy/builders.js';
import { rpc } from '../rpc/builders.js';
import { table } from '../schema/builders.js';
import type { EnumDef } from '../types/enum.js';
import type { PolicyRule } from '../types/policy.js';
import type { RpcDef } from '../types/rpc.js';
import type { TableDef } from '../types/schema.js';

/** Options of {@link tenantInvitations}. */
export interface TenantInvitationsOptions {
  /** Membership table (as in `definePermissions` tenant config); `roleColumn` is required. */
  tenant: { table: string; userColumn: string; tenantColumn: string; roleColumn: string };
  /** Tenant table the invitations belong to (foreign key target, primary key `id`). */
  tenantTable: string;
  /** Column of `tenantTable` shown to invitees by `my_invitations` (e.g. `'name'`). */
  tenantNameColumn?: string;
  /**
   * Roles an invitation may carry: a shared enum (`defineEnum`, the membership
   * column's type too) or the list of values.
   */
  roles: EnumDef | readonly string[];
  /**
   * Which roles may invite, and which roles each may hand out:
   * `{ owner: ['admin', 'member', 'viewer'], admin: ['member', 'viewer'] }`.
   */
  inviterRoles: Record<string, readonly string[]>;
  /** SQL type of the membership role column (default: the shared enum, or `<tenant.table>_<roleColumn>_enum`). */
  roleType?: string;
  /** Accepting needs a confirmed e-mail in auth.users (default true). */
  requireConfirmedEmail?: boolean;
  /** Invitations table name (default `'invitations'`). */
  table?: string;
  /** RPC names (default `accept_invitation` / `my_invitations`). */
  rpcNames?: { accept?: string; mine?: string };
}

/** The signed-in user's e-mail from the JWT, lower-cased. */
const MY_EMAIL = "lower((SELECT auth.jwt()) ->> 'email')";

/**
 * Invitations into a tenant (org, team...): the only consent-based way in.
 * Returns a table and two RPCs to spread into `defineSchema`:
 *
 * - `invitations` table: inviters (per `inviterRoles`) create invites for the
 *   roles they may hand out, in their own name; inviters read and revoke their
 *   tenant's invites; the invitee reads and declines the ones sent to their
 *   e-mail; nobody edits an invite.
 * - `accept_invitation(p_invitation uuid) → uuid` (SECURITY DEFINER): the
 *   invitee (signed in, confirmed e-mail matching the invite) joins the tenant
 *   with the invited role; the invitation is consumed. Returns the tenant id.
 * - `my_invitations()` (SECURITY DEFINER, STABLE): the caller's invitations with
 *   the tenant name, which they cannot read yet.
 *
 * @example
 * ```ts
 * const invites = tenantInvitations({
 *   tenant: { table: 'org_members', userColumn: 'user_id', tenantColumn: 'org_id', roleColumn: 'role' },
 *   tenantTable: 'orgs', tenantNameColumn: 'name',
 *   roles: ['admin', 'member', 'viewer'],
 *   inviterRoles: { owner: ['admin', 'member', 'viewer'], admin: ['member', 'viewer'] },
 * });
 * export default defineSchema({ ...tables, invitations: invites.table }, { rpcs: { ...invites.rpcs } });
 * ```
 */
export function tenantInvitations(options: TenantInvitationsOptions): {
  table: TableDef;
  rpcs: Record<string, RpcDef>;
  tableName: string;
} {
  const { tenant, tenantTable, inviterRoles } = options;
  const tableName = options.table ?? 'invitations';
  const tc = tenant.tenantColumn;
  const roleValues = Array.isArray(options.roles) ? [...(options.roles as readonly string[])] : [...(options.roles as EnumDef).values];
  const roleColumnType = Array.isArray(options.roles)
    ? `enum(${roleValues.map((v) => `'${v.replace(/'/g, "''")}'`).join(',')})`
    : (options.roles as EnumDef).type;
  const membershipRoleType = options.roleType
    ?? (Array.isArray(options.roles) ? `${tenant.table}_${tenant.roleColumn}_enum` : (options.roles as EnumDef).name);
  const quote = (v: string) => `'${v.replace(/'/g, "''")}'`;

  const member = (roles?: readonly string[]): PolicyRule => policy.belongsTo(tc, {
    table: tenant.table,
    foreignKey: tenant.tenantColumn,
    localKey: tenant.userColumn,
    ...(roles ? { where: { [tenant.roleColumn]: [...roles] } } : {}),
  });
  const inviters = Object.keys(inviterRoles);
  const isInvitee = policy.custom(`email = ${MY_EMAIL}`);
  const canHandOut = Object.entries(inviterRoles).map(([inviter, allowed]) =>
    policy.all([member([inviter]), policy.custom(`role IN (${allowed.map(quote).join(', ')})`)]));

  const invitationsTable = table({
    columns: {
      id: 'uuid',
      [tc]: 'uuid',
      email: { type: 'text', check: "email = lower(email) AND email LIKE '%_@_%'" },
      role: { type: roleColumnType as any, default: quote(roleValues[roleValues.length - 1] ?? 'member') },
      invited_by: 'uuid',
      created_at: { type: 'timestamptz', default: 'now()' },
    },
    primaryKey: 'id',
    references: { [tc]: `${tenantTable}.id`, invited_by: 'auth.users.id' },
    onDelete: { [tc]: 'cascade', invited_by: 'cascade' },
    indexes: [{ columns: [tc, 'email'], unique: true }, { columns: ['email'] }],
    policies: {
      select: policy.any([member(inviters), isInvitee]),
      insert: policy.all([policy.isOwner('invited_by'), canHandOut.length === 1 ? canHandOut[0] : policy.any(canHandOut)]),
      update: policy.none(),
      delete: policy.any([member(inviters), isInvitee]),
    },
  } as any);

  const accept = options.rpcNames?.accept ?? 'accept_invitation';
  const mine = options.rpcNames?.mine ?? 'my_invitations';
  const confirmed = options.requireConfirmedEmail !== false;
  const nameColumn = options.tenantNameColumn;

  const rpcs: Record<string, RpcDef> = {
    [accept]: rpc({
      args: { p_invitation: 'uuid' },
      returns: 'uuid',
      security: 'definer',
      body: `
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_email text := ${MY_EMAIL};
  v_tenant uuid;
  v_role text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'sign in first' USING ERRCODE = '42501';
  END IF;${confirmed ? `
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = v_uid AND u.email_confirmed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'confirm your e-mail first' USING ERRCODE = '42501';
  END IF;` : ''}
  SELECT i.${tc}, i.role::text INTO v_tenant, v_role
    FROM public.${tableName} i
   WHERE i.id = p_invitation AND i.email = v_email;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'invitation not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.${tenant.table} m WHERE m.${tenant.tenantColumn} = v_tenant AND m.${tenant.userColumn} = v_uid
  ) THEN
    INSERT INTO public.${tenant.table} (${tenant.tenantColumn}, ${tenant.userColumn}, ${tenant.roleColumn})
      VALUES (v_tenant, v_uid, v_role::public.${membershipRoleType});
  END IF;
  DELETE FROM public.${tableName} WHERE id = p_invitation;
  RETURN v_tenant;
END;`,
    }),
    [mine]: rpc({
      returns: {
        table: {
          id: 'uuid',
          [tc]: 'uuid',
          ...(nameColumn ? { tenant_name: 'text?' } : {}),
          role: `${tableName}.role`,
          created_at: 'timestamptz',
        },
      } as any,
      language: 'sql',
      volatility: 'stable',
      security: 'definer',
      body: `
SELECT i.id, i.${tc}${nameColumn ? `, t.${nameColumn}::text` : ''}, i.role, i.created_at
  FROM public.${tableName} i
${nameColumn ? `  JOIN public.${tenantTable} t ON t.id = i.${tc}\n` : ''} WHERE (SELECT auth.uid()) IS NOT NULL AND i.email = ${MY_EMAIL}
 ORDER BY i.created_at;`,
    }),
  };

  return { table: invitationsTable, rpcs, tableName };
}
