// ============================================
// AccessNexus - Policy Builders
// Fluent API for defining access control rules
// ============================================

import type {
  AllRule,
  AnyRule,
  AuthenticatedRule,
  BelongsToRule,
  CustomRule,
  MatchesFieldRule,
  NoneRule,
  OwnerRule,
  PolicyRule,
  PublicRule,
  RoleRule,
  WithCheckMode,
  WithCheckRule,
} from '../types/policy.js';

/**
 * Policy builders — one rule per operation (`select`, `insert`, `update`,
 * `delete`) in a table's `policies`. Each builder compiles to the RLS predicate
 * shown in its docs; AccessNexus adds `ENABLE` + `FORCE ROW LEVEL SECURITY` and wraps
 * `auth.uid()` as `(SELECT auth.uid())` so Postgres evaluates it once per query.
 *
 * A table with no `policies` gets no RLS at all (fully public through the
 * Supabase API). An operation left out of `policies` is denied once RLS is on.
 *
 * @example
 * ```ts
 * import { policy, table } from 'accessnexus';
 *
 * const posts = table({
 *   columns: { id: 'uuid', author_id: 'uuid', published: 'boolean' },
 *   primaryKey: 'id',
 *   policies: {
 *     select: policy.any([policy.isOwner('author_id'), policy.custom('published = true')]),
 *     insert: policy.isOwner('author_id'),
 *     update: policy.isOwner('author_id'),
 *     delete: policy.none(),
 *   },
 * });
 * ```
 */
export const policy = {
  // ---- Primitives ----

  /**
   * Any signed-in user. SQL: `(SELECT auth.uid()) IS NOT NULL`.
   *
   * @example
   * ```ts
   * policies: { select: policy.isAuthenticated() }
   * ```
   */
  isAuthenticated(): AuthenticatedRule {
    return { kind: 'authenticated' } as const;
  },

  /**
   * Everyone, including anonymous visitors. SQL: `TRUE`.
   * Use for public read access only — never for writes.
   *
   * @example
   * ```ts
   * policies: { select: policy.public() }
   * ```
   */
  public(): PublicRule {
    return { kind: 'public' } as const;
  },

  /**
   * Nobody through the API. SQL: `FALSE`. Server code using the service role
   * key (and triggers) still bypass RLS.
   *
   * @example
   * ```ts
   * policies: { update: policy.none(), delete: policy.none() }
   * ```
   */
  none(): NoneRule {
    return { kind: 'none' } as const;
  },

  /**
   * The row belongs to the current user. SQL: `(SELECT auth.uid()) = <column>`.
   * The column must be a `uuid` (usually referencing `auth.users.id`).
   *
   * @param column - Column holding the owner's user id (e.g. `'user_id'`).
   * @example
   * ```ts
   * policies: { select: policy.isOwner('user_id'), update: policy.isOwner('user_id') }
   * ```
   */
  isOwner(column: string): OwnerRule {
    return { kind: 'owner', column } as const;
  },

  /**
   * The user's global app role equals `role`, read from the JWT
   * `app_metadata.role` claim (set server-side, users cannot change it).
   * SQL: `((SELECT auth.jwt()) -> 'app_metadata' ->> 'role') = '<role>'`.
   *
   * Set it with the service role: `supabase.auth.admin.updateUserById(id,
   * { app_metadata: { role: 'admin' } })` (or a custom access token hook).
   * The top-level `role` claim is NOT used: in Supabase it is the Postgres role
   * (`anon` / `authenticated`). For roles inside an org/team (tenant), use
   * `definePermissions` with `{ scope: 'tenant', roles: ['admin'] }` or
   * `policy.belongsTo(col, { ..., where: { role: ['admin'] } })` instead.
   *
   * @param role - Expected `app_metadata.role` value (safely quoted).
   * @example
   * ```ts
   * // Only platform staff can read the audit trail
   * policies: { select: policy.hasRole('admin') }
   * ```
   */
  hasRole(role: string): RoleRule {
    return { kind: 'role', role } as const;
  },

  /**
   * The current user is a member of the row's group (org, team, shop...).
   * With `through`, membership is read from a join table via a
   * `SECURITY DEFINER` helper (no RLS recursion). Without `through`, it checks
   * `profiles.<column>` of the current user — only safe when users cannot write
   * that column (no profiles insert policy, `trigger.lockColumns` on it):
   * otherwise anyone can set it to another tenant's id and join that tenant.
   * `accessnexus validate` rejects that case (`BELONGS_TO_PROFILE_WRITABLE`).
   * Prefer `through` (a membership table).
   *
   * @param column - Column on this table holding the group id (e.g. `'org_id'`).
   * @param through - Join table: `table`, its `foreignKey` (group id), its
   *   `localKey` (user id) and optional `where` filters (e.g. `{ role: ['admin'] }`).
   * @example
   * ```ts
   * policies: {
   *   select: policy.belongsTo('org_id', { table: 'org_members', foreignKey: 'org_id', localKey: 'user_id' }),
   *   delete: policy.belongsTo('org_id', {
   *     table: 'org_members', foreignKey: 'org_id', localKey: 'user_id', where: { role: ['admin'] },
   *   }),
   * }
   * ```
   */
  belongsTo(
    column: string,
    through?: {
      table: string;
      foreignKey: string;
      localKey: string;
      /** Additional WHERE filters on the join table (e.g. { role: ['manager'] }) */
      where?: Record<string, string | string[]>;
    }
  ): BelongsToRule {
    return { kind: 'belongs_to', column, through } as const;
  },

  /**
   * Two values must be equal. SQL: `<fieldA> = <fieldB>`. Either side may be a
   * column or an auth call such as `'auth.uid()'` (wrapped automatically).
   *
   * @param fieldA - First column or expression.
   * @param fieldB - Second column or expression.
   * @example
   * ```ts
   * policies: { insert: policy.matchesField('author_id', 'auth.uid()') }
   * ```
   */
  matchesField(fieldA: string, fieldB: string): MatchesFieldRule {
    return { kind: 'matches_field', fieldA, fieldB } as const;
  },

  /**
   * Raw SQL predicate — escape hatch. Write `(SELECT auth.uid())`, never a bare
   * `auth.uid()` (`accessnexus validate` warns about it).
   *
   * @param expression - SQL boolean expression evaluated per row.
   * @param adapter - Optional: target a specific adapter.
   * @example
   * ```ts
   * policies: { select: policy.custom("status = 'published'") }
   * ```
   */
  custom(expression: string, adapter?: string): CustomRule {
    return { kind: 'custom', expression, adapter } as const;
  },

  // ---- Combinators ----

  /**
   * OR — passes when any rule passes.
   *
   * @param rules - At least one rule.
   * @example
   * ```ts
   * policies: { select: policy.any([policy.isOwner('user_id'), policy.custom('is_public = true')]) }
   * ```
   */
  any(rules: PolicyRule[]): AnyRule {
    return { kind: 'any', rules } as const;
  },

  /**
   * AND — passes only when every rule passes.
   *
   * @param rules - At least one rule.
   * @example
   * ```ts
   * policies: { update: policy.all([policy.isOwner('user_id'), policy.custom('locked = false')]) }
   * ```
   */
  all(rules: PolicyRule[]): AllRule {
    return { kind: 'all', rules } as const;
  },

  // ---- Advanced ----

  /**
   * Add a condition the written row must satisfy (`WITH CHECK`) on top of the
   * rule for which rows the user may target (`USING`). By default the written
   * row must pass BOTH `using` and `check`, so an UPDATE can never move a row
   * out of the user's ownership/tenant. On `insert` there is no `USING`; both
   * rules go into `WITH CHECK`.
   *
   * @param using - Which existing rows the user may target (also required of the new row).
   * @param check - Extra condition on the written row.
   * @param options - `{ mode: 'replace' }` drops `using` from `WITH CHECK` (the new
   *   row only has to pass `check`); only use it when that is really intended.
   * @example
   * ```ts
   * policies: {
   *   // Authors edit their comments, and every edit must set edited = true
   *   update: policy.withCheck(policy.isOwner('author_id'), policy.custom('edited = true')),
   * }
   * ```
   */
  withCheck(using: PolicyRule, check: PolicyRule, options: { mode?: WithCheckMode } = {}): WithCheckRule {
    return options.mode ? { kind: 'with_check', using, check, mode: options.mode } : { kind: 'with_check', using, check };
  },
} as const;
