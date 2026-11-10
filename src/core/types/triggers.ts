// ============================================
// AccessNexus - Trigger Types
// Adapter-agnostic trigger definitions
// ============================================

/**
 * Trigger timing + event combinations.
 */
export type TriggerEvent =
  | 'before_insert'
  | 'after_insert'
  | 'before_update'
  | 'after_update'
  | 'before_delete'
  | 'after_delete';

/**
 * Trigger granularity.
 */
export type TriggerForEach = 'row' | 'statement';

// ---- Trigger Rule Types (discriminated union) ----

/**
 * Base trigger rule — all triggers have a `kind` discriminator.
 */
export interface TriggerRule {
  readonly kind: string;
}

/**
 * Auto-update a timestamp column on UPDATE.
 * Generates: BEFORE UPDATE → `NEW.column = NOW(); RETURN NEW;`
 */
export interface UpdatedAtTrigger extends TriggerRule {
  readonly kind: 'updated_at';
  readonly column: string;
}

/**
 * Soft delete — intercept DELETE and set a column to NOW() instead.
 * Generates: BEFORE DELETE → `UPDATE table SET column = NOW() WHERE pk = OLD.pk; RETURN NULL;`
 */
export interface SoftDeleteTrigger extends TriggerRule {
  readonly kind: 'soft_delete';
  readonly column: string;
}

/**
 * Audit log — log row changes to an audit table.
 * Generates: AFTER INSERT/UPDATE/DELETE → inserts old/new data as JSONB.
 */
export interface AuditLogTrigger extends TriggerRule {
  readonly kind: 'audit_log';
  /** Target audit log table name */
  readonly table: string;
  /** Only log specific columns (default: all — logs entire row) */
  readonly columns?: string[];
}

/**
 * Lock columns against UPDATE by API users (anon/authenticated).
 * Generates: BEFORE UPDATE → raises when a locked column changes, unless the
 * `unless` SQL condition is true. RLS cannot compare OLD and NEW; this can.
 */
export interface LockColumnsTrigger extends TriggerRule {
  readonly kind: 'lock_columns';
  /** Trigger name suffix (default: 'lock_columns'). */
  readonly name?: string;
  /** Columns that may not change. Use this OR `except`. */
  readonly columns?: string[];
  /** Every column EXCEPT these may not change. Use this OR `columns`. */
  readonly except?: string[];
  /** SQL condition (NEW/OLD available) under which the change is allowed. */
  readonly unless?: string;
}

/**
 * Custom trigger with full control over PL/pgSQL function body.
 */
export interface CustomTrigger extends TriggerRule {
  readonly kind: 'custom';
  /** Trigger name suffix (used in generated function/trigger names) */
  readonly name: string;
  /** When the trigger fires */
  readonly events: TriggerEvent[];
  /** PL/pgSQL function body (without CREATE FUNCTION wrapper) */
  readonly functionBody: string;
  /** Optional WHEN condition (SQL expression) */
  readonly when?: string;
  /** FOR EACH ROW or STATEMENT (default: row) */
  readonly forEach?: TriggerForEach;
  /**
   * `'invoker'` (default): runs as the writing user, RLS applies to what it
   * writes. `'definer'`: runs as the function owner and bypasses RLS — for
   * trusted side effects such as creating the first membership row.
   */
  readonly security?: 'invoker' | 'definer';
  /**
   * Function configuration (`SET key = 'value'`), e.g. `{ row_security: 'off' }`.
   * Same rules as `rpc({ set })`: `search_path` stays pinned by the generator.
   */
  readonly set?: Readonly<Record<string, string>>;
  /** Other tables the function writes: React Query mutations of this table invalidate them too. */
  readonly writes?: readonly string[];
}

/**
 * All trigger rule types.
 */
/** Rule from `trigger.keepAtLeastOne(...)`: a row with `column = value` always remains per `scope`. */
export interface KeepAtLeastOneTrigger extends TriggerRule {
  readonly kind: 'keep_at_least_one';
  readonly column: string;
  readonly value: string;
  readonly scope: string;
  /** `'orgs.id'`: when the parent row is gone (cascade delete), the guard steps aside. */
  readonly parent?: string;
  readonly name?: string;
}

/** Rule from `trigger.sameTenant(...)`: `column` points to a row of the same tenant. */
export interface SameTenantTrigger extends TriggerRule {
  readonly kind: 'same_tenant';
  readonly column: string;
  readonly references: string;
  readonly tenantColumn: string;
  readonly referencesTenantColumn?: string;
  readonly name?: string;
}

/** Rule from `trigger.memberOfTenant(...)`: `column` is a user who is a member of the row's tenant. */
export interface MemberOfTenantTrigger extends TriggerRule {
  readonly kind: 'member_of_tenant';
  readonly column: string;
  readonly tenant: { readonly table: string; readonly userColumn: string; readonly tenantColumn: string };
  readonly tenantColumn?: string;
  readonly name?: string;
}

/** Rule from `trigger.onAuthUserCreated(...)`: insert a row of this table for every new auth user. */
export interface OnAuthUserCreatedTrigger extends TriggerRule {
  readonly kind: 'on_auth_user_created';
  /** Column → SQL expression over `NEW` (the auth.users row), e.g. `{ id: 'NEW.id' }`. */
  readonly columns: Readonly<Record<string, string>>;
  readonly name?: string;
}

export type TriggerRuleType =
  | UpdatedAtTrigger
  | SoftDeleteTrigger
  | AuditLogTrigger
  | LockColumnsTrigger
  | CustomTrigger
  | KeepAtLeastOneTrigger
  | SameTenantTrigger
  | MemberOfTenantTrigger
  | OnAuthUserCreatedTrigger;

/**
 * Array of trigger rules for a table.
 */
export type TableTriggers = TriggerRule[];
