// ============================================
// AccessNexus - Permissions Types
// Declarative RBAC with multi-tenant support
// ============================================

import type { PolicyRule, TablePolicies } from './policy.js';

/**
 * Tenant-scoped permission: user must be a member of the tenant.
 * Optionally restricted to specific roles within the tenant.
 */
export interface TenantScope {
  /** Must be 'tenant' */
  scope: 'tenant';
  /** Optional: restrict to specific roles within the tenant (checked via roleColumn) */
  roles?: string[];
}

/**
 * Combine multiple permission levels with OR.
 */
export interface AnyPermission {
  any: PermissionLevel[];
}

/**
 * Permission level for a resource action.
 * - `'*'`              — all authenticated users
 * - `'public'`         — no auth required
 * - `'none'`           — blocked
 * - `'own'`            — only the row owner (requires ownerColumn)
 * - `string[]`         — global app roles (OR'd), read from the JWT
 *                        `app_metadata.role` claim — NOT roles inside a tenant;
 *                        for org/team roles use `{ scope: 'tenant', roles }`
 * - `{ scope: 'tenant' }` — tenant member
 * - `{ scope: 'tenant', roles: [...] }` — tenant member with specific role
 * - `{ any: [...] }`   — OR combination of levels
 */
export type PermissionLevel =
  | '*'
  | 'public'
  | 'none'
  | 'own'
  | string[]
  | TenantScope
  | AnyPermission;

/**
 * Resource permission definition.
 */
export interface ResourcePermissions {
  /** Column that identifies the row owner (required if using 'own') */
  ownerColumn?: string;
  /** Column that links this resource to a tenant (required if using scope: 'tenant') */
  tenantColumn?: string;
  /**
   * Writes must keep the row inside a tenant the user belongs to (default: true
   * when `tenantColumn` and a tenant config exist). `update`, and `create` when
   * its level is not already tenant-scoped, get tenant membership AND-ed into
   * `WITH CHECK`, so an owner cannot move or create a row in another tenant.
   * Never applied to `create` when `tenantColumn` is `'id'` (the row is the
   * tenant itself). Set `false` for resources written by non-members
   * (e.g. customers booking into a shop).
   */
  pinTenant?: boolean;
  /**
   * `create` requires `ownerColumn = auth.uid()` (default: true when
   * `ownerColumn` is set and the create level is not `'public'`/`'none'`), so
   * nobody can create rows attributed to someone else. Set `false` when the
   * owner column is assigned by others (e.g. a task's `assignee_id`).
   */
  pinOwnerOnCreate?: boolean;
  /** Who can read (SELECT) */
  read?: PermissionLevel;
  /** Who can create (INSERT) */
  create?: PermissionLevel;
  /** Who can update (UPDATE) */
  update?: PermissionLevel;
  /** Who can delete (DELETE) */
  delete?: PermissionLevel;
}

/**
 * Multi-tenant configuration.
 * Defines the join table that links users to tenants.
 */
export interface TenantConfig {
  /** Join table name (e.g. 'shop_members') */
  table: string;
  /** Column in join table that references the user (e.g. 'user_id') */
  userColumn: string;
  /** Column in join table that references the tenant (e.g. 'shop_id') */
  tenantColumn: string;
  /** Optional: column in join table that holds the user's role within the tenant */
  roleColumn?: string;
}

/**
 * Input to definePermissions(). `R` is inferred from the `resources` keys.
 */
export interface PermissionsInput<R extends string = string> {
  /** Available roles in the system */
  roles: string[];
  /** Multi-tenant configuration (required if any resource uses scope: 'tenant') */
  tenant?: TenantConfig;
  /** Permission map per resource (table) name */
  resources: Record<R, ResourcePermissions>;
}

/**
 * The resolved permissions object returned by definePermissions(). `can` and
 * `policiesFor` accept only the declared resource names (`R`), so a typo is a
 * type error.
 */
export interface PermissionsDef<R extends string = string> {
  /** Original roles list */
  readonly roles: readonly string[];
  /** Tenant configuration (if defined) */
  readonly tenant: TenantConfig | undefined;
  /** Original resource definitions */
  readonly resources: Readonly<Record<R, ResourcePermissions>>;
  /** Get a single PolicyRule for a resource action */
  can(resource: R, action: 'read' | 'create' | 'update' | 'delete'): PolicyRule;
  /** Get full TablePolicies for a resource */
  policiesFor(resource: R): TablePolicies;
}
