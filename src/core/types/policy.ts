// ============================================
// AccessNexus - Policy Types
// Adapter-agnostic policy definitions
// ============================================

/**
 * Policy operations that can be controlled.
 * Maps to CRUD operations across all adapters.
 */
export type PolicyOperation = 'select' | 'insert' | 'update' | 'delete';

/**
 * Base policy rule interface.
 * Every policy rule has a kind that adapters use to generate
 * platform-specific access control code.
 */
export interface PolicyRule {
  readonly kind: string;
}

// ---- Primitive Rules ----

/** Rule from `policy.isAuthenticated()`. */
export interface AuthenticatedRule extends PolicyRule {
  readonly kind: 'authenticated';
}

/** Rule from `policy.public()`. */
export interface PublicRule extends PolicyRule {
  readonly kind: 'public';
}

/** Rule from `policy.none()`. */
export interface NoneRule extends PolicyRule {
  readonly kind: 'none';
}

/** Rule from `policy.isOwner(column)`. */
export interface OwnerRule extends PolicyRule {
  readonly kind: 'owner';
  readonly column: string;
}

/** Rule from `policy.hasRole(role)`. */
export interface RoleRule extends PolicyRule {
  readonly kind: 'role';
  readonly role: string;
}

/** Rule from `policy.belongsTo(column, through?)`. */
export interface BelongsToRule extends PolicyRule {
  readonly kind: 'belongs_to';
  readonly column: string;
  readonly through?: {
    table: string;
    foreignKey: string;
    localKey: string;
    /** Additional WHERE filters on the join table (e.g. { role: ['manager'] }) */
    where?: Record<string, string | string[]>;
  };
}

/** Rule from `policy.matchesField(a, b)`. */
export interface MatchesFieldRule extends PolicyRule {
  readonly kind: 'matches_field';
  readonly fieldA: string;
  readonly fieldB: string;
}

/** Rule from `policy.custom(expression)`. */
export interface CustomRule extends PolicyRule {
  readonly kind: 'custom';
  readonly expression: string;
  /** Adapter hint - which adapters this custom rule targets */
  readonly adapter?: string;
}

// ---- Combinators ----

/** Rule from `policy.any(rules)` (OR). */
export interface AnyRule extends PolicyRule {
  readonly kind: 'any';
  readonly rules: PolicyRule[];
}

/** Rule from `policy.all(rules)` (AND). */
export interface AllRule extends PolicyRule {
  readonly kind: 'all';
  readonly rules: PolicyRule[];
}

// ---- With Check (separate write validation) ----

/**
 * How `policy.withCheck` builds `WITH CHECK`:
 * - `'and'` (default) — the written row must pass `using` AND `check`, so the
 *   ownership/tenant condition in `using` can never be written away.
 * - `'replace'` — the written row must pass `check` only (use when the new row
 *   may legitimately leave the `using` condition, e.g. publishing a draft).
 */
export type WithCheckMode = 'and' | 'replace';

/** Rule from `policy.withCheck(using, check, options?)`. */
export interface WithCheckRule extends PolicyRule {
  readonly kind: 'with_check';
  readonly using: PolicyRule;
  readonly check: PolicyRule;
  readonly mode?: WithCheckMode;
}

// ---- Union of all rule types ----

/** Every built-in policy rule shape (discriminated by `kind`). */
export type PolicyRuleType =
  | AuthenticatedRule
  | PublicRule
  | NoneRule
  | OwnerRule
  | RoleRule
  | BelongsToRule
  | MatchesFieldRule
  | CustomRule
  | AnyRule
  | AllRule
  | WithCheckRule;

/**
 * Policies for a table: one rule per operation.
 * All operations are optional — undefined means no policy generated
 * (inherits default behavior from the adapter).
 */
export type TablePolicies = {
  [K in PolicyOperation]?: PolicyRule;
};
