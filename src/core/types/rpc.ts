// ============================================
// AccessNexus - RPC (PostgreSQL Function) Types
// Adapter-agnostic function definitions
// ============================================

import type { ColumnType } from './columns.js';

/** Function language */
export type RpcLanguage = 'plpgsql' | 'sql';

/** Security context */
export type RpcSecurity = 'invoker' | 'definer';

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

  /** Function arguments: name → ColumnType */
  readonly args?: Record<string, ColumnType>;

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
