// ============================================
// AccessNexus - RPC (PostgreSQL Function) Types
// Adapter-agnostic function definitions
// ============================================

import type { ColumnType } from './columns.js';

/** Function language */
export type RpcLanguage = 'plpgsql' | 'sql';

/** Security context */
export type RpcSecurity = 'invoker' | 'definer';

/**
 * An RPC argument: a column type, or `{ type, default }` where `default` is a
 * raw SQL expression emitted verbatim after `DEFAULT` (e.g. `'20'`, `'now()'`,
 * `"'pending'"`). Postgres requires every argument after one with a default
 * to have a default too; callers may omit arguments that have one.
 */
export type RpcArg = ColumnType | { readonly type: ColumnType; readonly default?: string };

/** Return type for an RPC function */
export type RpcReturnType = ColumnType | 'void';

/**
 * RPC (PostgreSQL function) definition.
 *
 * Three usage modes:
 * - `rpc()` — marker only, types come from Database (Database mode)
 * - `rpc({ args, returns })` — signature only (typed client, no SQL)
 * - `rpc({ args, returns, body })` — full definition (generates SQL + typed client)
 */
export interface RpcDef {
  /** Marker to distinguish RPC definitions from table definitions */
  readonly _rpc: true;

  /** Function arguments: name → ColumnType, or `{ type, default }` */
  readonly args?: Record<string, RpcArg>;

  /** Return type */
  readonly returns?: RpcReturnType;

  /** PL/pgSQL or SQL function body (without CREATE FUNCTION wrapper) */
  readonly body?: string;

  /** Function language (default: plpgsql) */
  readonly language?: RpcLanguage;

  /** Security context (default: invoker) */
  readonly security?: RpcSecurity;

  /** Whether the function is immutable (default: false → volatile) */
  readonly immutable?: boolean;

  /**
   * `security: 'definer'` only: also let anonymous visitors call it (default
   * false). Definer RPCs bypass RLS, so AccessNexus revokes EXECUTE from PUBLIC and
   * `anon` and grants it to `authenticated` and `service_role`.
   */
  readonly allowAnon?: boolean;
}
