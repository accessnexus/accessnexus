// ============================================
// AccessNexus - Trigger Builders
// Fluent API for defining database triggers
// ============================================

import type {
  AuditLogTrigger,
  CustomTrigger,
  LockColumnsTrigger,
  SoftDeleteTrigger,
  TriggerEvent,
  TriggerForEach,
  UpdatedAtTrigger,
} from '../types/triggers.js';

/**
 * Trigger builders — put them in a table's `triggers` array. AccessNexus generates
 * the PL/pgSQL function (with a pinned `search_path`) and the `CREATE TRIGGER`.
 *
 * @example
 * ```ts
 * import { table, trigger } from 'accessnexus';
 *
 * const posts = table({
 *   columns: { id: 'uuid', title: 'text', updated_at: 'timestamptz?' },
 *   primaryKey: 'id',
 *   triggers: [trigger.updatedAt('updated_at'), trigger.auditLog({ table: 'audit_log' })],
 * });
 * ```
 */
export const trigger = {
  // ---- Presets ----

  /**
   * Auto-update a timestamp column on every UPDATE.
   * Fires BEFORE UPDATE, sets `column = NOW()`.
   *
   * @param column - Timestamp column name (e.g., 'updated_at')
   * @example
   * ```ts
   * triggers: [trigger.updatedAt('updated_at')]
   * ```
   */
  updatedAt(column: string): UpdatedAtTrigger {
    return { kind: 'updated_at', column } as const;
  },

  /**
   * Soft delete — intercept DELETE and set a timestamp instead.
   * Fires BEFORE DELETE, sets `column = NOW()` and cancels the DELETE.
   *
   * Setting `softDelete: 'deleted_at'` on the table adds this trigger for you
   * (and makes the SDK filter out deleted rows).
   *
   * @param column - Timestamp column for soft delete (e.g., 'deleted_at')
   * @example
   * ```ts
   * triggers: [trigger.softDelete('deleted_at')]
   * ```
   */
  softDelete(column: string): SoftDeleteTrigger {
    return { kind: 'soft_delete', column } as const;
  },

  /**
   * Audit log — log row changes (INSERT/UPDATE/DELETE) to an audit table.
   * Fires AFTER INSERT, UPDATE, and DELETE.
   *
   * @param options - Audit log configuration
   * @param options.table - Target audit log table name
   * @param options.columns - Only log specific columns (default: all)
   * @example
   * ```ts
   * // The target table must exist in the schema (see the audit-log recipe in llms.txt).
   * triggers: [trigger.auditLog({ table: 'audit_log', columns: ['status'] })]
   * ```
   */
  auditLog(options: { table: string; columns?: string[] }): AuditLogTrigger {
    return {
      kind: 'audit_log',
      table: options.table,
      columns: options.columns,
    } as const;
  },

  /**
   * Lock columns so API users (anon/authenticated) cannot change them with
   * UPDATE. RLS decides WHICH rows a user may update, never WHICH COLUMNS:
   * use this to freeze an owner/creator/tenant column, or to let some users
   * change only a few columns. Fires BEFORE UPDATE and raises (SQLSTATE 42501)
   * when a locked column changes and `unless` is not true. The service role,
   * SECURITY DEFINER triggers/RPCs and columns maintained by
   * `trigger.updatedAt` are never blocked.
   *
   * @param options.columns - Columns that may not change. Use this OR `except`.
   * @param options.except - Lock every column except these.
   * @param options.unless - Raw SQL condition (NEW/OLD available, write
   *   `(SELECT auth.uid())`) under which the change is allowed, e.g. "the user
   *   is an org admin".
   * @param options.name - Trigger name suffix (default `lock_columns`); set it
   *   when a table has more than one lockColumns trigger.
   * @example
   * ```ts
   * triggers: [
   *   // Nobody re-attributes or moves a task
   *   trigger.lockColumns({ name: 'lock_identity', columns: ['reporter_id', 'org_id'] }),
   *   // Assignees change only status; org admins change anything
   *   trigger.lockColumns({
   *     except: ['status'],
   *     unless: "EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = NEW.org_id AND m.user_id = (SELECT auth.uid()) AND m.role = 'admin')",
   *   }),
   * ]
   * ```
   */
  lockColumns(options: { columns?: string[]; except?: string[]; unless?: string; name?: string }): LockColumnsTrigger {
    return {
      kind: 'lock_columns',
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.columns !== undefined ? { columns: options.columns } : {}),
      ...(options.except !== undefined ? { except: options.except } : {}),
      ...(options.unless !== undefined ? { unless: options.unless } : {}),
    } as const;
  },

  // ---- Escape hatch ----

  /**
   * Custom trigger with full control over the PL/pgSQL function body.
   *
   * @param options - Custom trigger configuration
   * @param options.name - Trigger name suffix
   * @param options.events - When the trigger fires
   * @param options.functionBody - PL/pgSQL function body
   * @param options.when - Optional WHEN condition
   * @param options.forEach - FOR EACH ROW or STATEMENT (default: row)
   * @param options.security - `'invoker'` (default, RLS applies to what the
   *   body writes) or `'definer'` (runs as the owner and bypasses RLS — only for
   *   trusted side effects such as adding the creator as first team owner)
   * @example
   * ```ts
   * triggers: [
   *   trigger.custom({
   *     name: 'lowercase_email',
   *     events: ['before_insert', 'before_update'],
   *     functionBody: 'NEW.email = lower(NEW.email); RETURN NEW;',
   *   }),
   * ]
   * ```
   */
  custom(options: {
    name: string;
    events: TriggerEvent[];
    functionBody: string;
    when?: string;
    forEach?: TriggerForEach;
    security?: 'invoker' | 'definer';
  }): CustomTrigger {
    return {
      kind: 'custom',
      name: options.name,
      events: options.events,
      functionBody: options.functionBody,
      when: options.when,
      forEach: options.forEach,
      ...(options.security !== undefined ? { security: options.security } : {}),
    } as const;
  },
} as const;
