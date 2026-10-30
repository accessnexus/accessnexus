// ============================================
// AccessNexus - Permissions Builders
// Declarative RBAC with multi-tenant support
// ============================================

import type { PolicyRule, PolicyRuleType, TablePolicies } from '../types/policy.js';
import type {
  AnyPermission,
  PermissionLevel,
  PermissionsDef,
  PermissionsInput,
  ResourcePermissions,
  TenantConfig,
  TenantScope,
} from '../types/permissions.js';

function isTenantScope(level: PermissionLevel): level is TenantScope {
  return typeof level === 'object' && !Array.isArray(level) && 'scope' in level && level.scope === 'tenant';
}

function isAnyPermission(level: PermissionLevel): level is AnyPermission {
  return typeof level === 'object' && !Array.isArray(level) && 'any' in level;
}

/**
 * Resolve a PermissionLevel into a PolicyRule.
 */
function levelToRule(
  level: PermissionLevel,
  ownerColumn: string | undefined,
  tenantColumn: string | undefined,
  tenant: TenantConfig | undefined,
): PolicyRuleType {
  if (level === 'public') {
    return { kind: 'public' };
  }
  if (level === '*') {
    return { kind: 'authenticated' };
  }
  if (level === 'none') {
    return { kind: 'none' };
  }
  if (level === 'own') {
    if (!ownerColumn) {
      throw new Error(
        `[AccessNexus] Permission level 'own' requires ownerColumn to be set on the resource`
      );
    }
    return { kind: 'owner', column: ownerColumn };
  }

  // Tenant scope
  if (isTenantScope(level)) {
    if (!tenant) {
      throw new Error(
        `[AccessNexus] Permission level { scope: 'tenant' } requires a tenant config in definePermissions()`
      );
    }
    if (!tenantColumn) {
      throw new Error(
        `[AccessNexus] Permission level { scope: 'tenant' } requires tenantColumn to be set on the resource`
      );
    }
    const through: any = {
      table: tenant.table,
      foreignKey: tenant.tenantColumn,
      localKey: tenant.userColumn,
    };
    if (level.roles && level.roles.length > 0) {
      if (!tenant.roleColumn) {
        throw new Error(
          `[AccessNexus] Tenant-scoped roles require tenant.roleColumn to be defined`
        );
      }
      through.where = { [tenant.roleColumn]: level.roles };
    }
    return { kind: 'belongs_to', column: tenantColumn, through };
  }

  // Any combination
  if (isAnyPermission(level)) {
    const rules = level.any.map((sub) => levelToRule(sub, ownerColumn, tenantColumn, tenant));
    if (rules.length === 1) return rules[0];
    return { kind: 'any', rules };
  }

  // Array of roles
  if (Array.isArray(level)) {
    if (level.length === 0) {
      return { kind: 'none' };
    }
    if (level.length === 1) {
      return { kind: 'role', role: level[0] };
    }
    return {
      kind: 'any',
      rules: level.map((role) => ({ kind: 'role' as const, role })),
    };
  }

  throw new Error(`[AccessNexus] Invalid permission level: ${JSON.stringify(level)}`);
}

function containsTenantScope(level: PermissionLevel): boolean {
  if (isTenantScope(level)) return true;
  if (isAnyPermission(level)) return level.any.some(containsTenantScope);
  return false;
}

/**
 * The rule for one action, plus the write pins (see ResourcePermissions):
 * tenant membership on create/update and owner = auth.uid() on create.
 */
function actionToRule(
  perms: ResourcePermissions,
  action: 'read' | 'create' | 'update' | 'delete',
  level: PermissionLevel,
  tenant: TenantConfig | undefined,
): PolicyRuleType {
  const rule = levelToRule(level, perms.ownerColumn, perms.tenantColumn, tenant);
  if (action !== 'create' && action !== 'update') return rule;
  if (level === 'public' || level === 'none') return rule;

  const pins: PolicyRuleType[] = [];
  const tenantPinApplies =
    perms.pinTenant !== false
    && tenant !== undefined
    && perms.tenantColumn !== undefined
    && !isTenantScope(level)
    && !(action === 'create' && perms.tenantColumn === 'id');
  if (tenantPinApplies) {
    pins.push({
      kind: 'belongs_to',
      column: perms.tenantColumn!,
      through: { table: tenant!.table, foreignKey: tenant!.tenantColumn, localKey: tenant!.userColumn },
    });
  }
  if (action === 'create' && perms.ownerColumn && perms.pinOwnerOnCreate !== false && level !== 'own') {
    pins.push({ kind: 'owner', column: perms.ownerColumn });
  }

  if (pins.length === 0) return rule;
  const check: PolicyRuleType = pins.length === 1 ? pins[0] : { kind: 'all', rules: pins };
  return { kind: 'with_check', using: rule, check };
}

const ACTION_TO_OP = {
  read: 'select',
  create: 'insert',
  update: 'update',
  delete: 'delete',
} as const;

/**
 * Check if any resource uses tenant scoping.
 */
function expandAllLevel(perms: ResourcePermissions): ResourcePermissions {
  if (!perms || typeof perms !== 'object' || perms.all === undefined) return perms;
  const { all, ...rest } = perms;
  return {
    ...rest,
    read: rest.read ?? all,
    create: rest.create ?? all,
    update: rest.update ?? all,
    delete: rest.delete ?? all,
  };
}

function usesTenantScope(resources: Record<string, ResourcePermissions>): boolean {
  for (const perms of Object.values(resources)) {
    for (const action of ['read', 'create', 'update', 'delete'] as const) {
      const level = perms[action];
      if (level === undefined) continue;
      if (isTenantScope(level)) return true;
      if (isAnyPermission(level) && level.any.some(isTenantScope)) return true;
    }
  }
  return false;
}

/**
 * Collect all role names referenced in permission levels (including tenant-scoped roles).
 */
function collectReferencedRoles(level: PermissionLevel): string[] {
  if (Array.isArray(level)) return level;
  if (isTenantScope(level)) return level.roles ?? [];
  if (isAnyPermission(level)) return level.any.flatMap(collectReferencedRoles);
  return [];
}

/**
 * Define a centralized RBAC permissions map with optional multi-tenant support.
 *
 * Levels: `'public'`, `'*'` (any signed-in user), `'none'`, `'own'`
 * (`ownerColumn = auth.uid()`), `{ scope: 'tenant', roles? }` (member of the
 * row's tenant, optionally with a role from `tenant.roleColumn`), `{ any: [...] }`
 * (OR), and `string[]` — GLOBAL app roles from the JWT `app_metadata.role`
 * claim (not tenant roles: for "org admins" use `{ scope: 'tenant', roles: ['admin'] }`).
 *
 * Writes are pinned by default: `create` requires `ownerColumn = auth.uid()`
 * (`pinOwnerOnCreate`), and `create`/`update` keep the row inside a tenant the
 * user belongs to (`pinTenant`). See {@link ResourcePermissions}.
 *
 * @example
 * ```ts
 * const permissions = definePermissions({
 *   roles: ['admin', 'manager', 'member'],
 *   tenant: {
 *     table: 'org_members',
 *     userColumn: 'user_id',
 *     tenantColumn: 'org_id',
 *     roleColumn: 'role',
 *   },
 *   resources: {
 *     projects: {
 *       ownerColumn: 'created_by',
 *       tenantColumn: 'org_id',
 *       read: { scope: 'tenant' },                              // any org member
 *       create: { scope: 'tenant', roles: ['admin', 'manager'] },
 *       update: { any: ['own', { scope: 'tenant', roles: ['admin', 'manager'] }] },
 *       delete: { scope: 'tenant', roles: ['admin'] },           // org admins
 *     },
 *     bookings: {
 *       ownerColumn: 'client_id',
 *       tenantColumn: 'org_id',
 *       pinTenant: false,           // customers (not members) book into an org
 *       read: { any: ['own', { scope: 'tenant' }] },
 *       create: '*',
 *       update: 'own',
 *       delete: { scope: 'tenant', roles: ['admin'] },
 *     },
 *   },
 * });
 * // projects: permissions.policiesFor('projects')
 * ```
 */
export function definePermissions<R extends string>(rawInput: PermissionsInput<R>): PermissionsDef<R> {
  // `all` fills every action that has no level of its own.
  const input: PermissionsInput<R> = {
    ...rawInput,
    resources: Object.fromEntries(
      Object.entries(rawInput.resources as Record<string, ResourcePermissions>).map(([name, perms]) => [name, expandAllLevel(perms)]),
    ) as PermissionsInput<R>['resources'],
  };
  // Validate: tenant config required if any resource uses tenant scope
  if (!input.tenant && usesTenantScope(input.resources)) {
    throw new Error(
      `[AccessNexus] Some resources use { scope: 'tenant' } but no tenant config was provided`
    );
  }

  // Validate roles in resource definitions
  for (const [resource, perms] of Object.entries(input.resources) as Array<[string, ResourcePermissions]>) {
    for (const action of ['read', 'create', 'update', 'delete'] as const) {
      const level = perms[action];
      if (level === undefined) continue;
      const referenced = collectReferencedRoles(level);
      for (const role of referenced) {
        if (!input.roles.includes(role)) {
          throw new Error(
            `[AccessNexus] Unknown role "${role}" in ${resource}.${action}. Available roles: ${input.roles.join(', ')}`
          );
        }
      }
    }
  }

  return {
    roles: Object.freeze([...input.roles]),
    tenant: input.tenant,
    resources: Object.freeze(input.resources),

    can(resource: R, action: 'read' | 'create' | 'update' | 'delete'): PolicyRule {
      const perms = (input.resources as Record<string, ResourcePermissions>)[resource];
      if (!perms) {
        throw new Error(
          `[AccessNexus] Resource "${resource}" not found in permissions. Available: ${Object.keys(input.resources).join(', ')}`
        );
      }
      const level = perms[action];
      if (level === undefined) {
        throw new Error(
          `[AccessNexus] No permission defined for ${resource}.${action}`
        );
      }
      return actionToRule(perms, action, level, input.tenant);
    },

    policiesFor(resource: R): TablePolicies {
      const perms = (input.resources as Record<string, ResourcePermissions>)[resource];
      if (!perms) {
        throw new Error(
          `[AccessNexus] Resource "${resource}" not found in permissions. Available: ${Object.keys(input.resources).join(', ')}`
        );
      }
      const policies: TablePolicies = {};
      for (const action of ['read', 'create', 'update', 'delete'] as const) {
        const level = perms[action];
        if (level !== undefined) {
          policies[ACTION_TO_OP[action]] = actionToRule(perms, action, level, input.tenant);
        }
      }
      return policies;
    },
  };
}
