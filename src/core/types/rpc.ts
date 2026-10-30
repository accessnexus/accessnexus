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

/** Function volatility (`CREATE FUNCTION ... VOLATILE | STABLE | IMMUTABLE`). */
export type RpcVolatility = 'volatile' | 'stable' | 'immutable';

/**
 * `RETURNS TABLE(...)`: output column name → column type. The SDK types the
 * result as an array of rows (`{ col: type }[]`), like `supabase gen types`.
 */
export interface RpcTableReturn {
  readonly table: Readonly<Record<string, ColumnType>>;
}

/**
 * `RETURNS SETOF <x>`: a table name of the schema (SDK: that table's `Row[]`)
 * or a column type (SDK: an array of that type, e.g. `{ setof: 'uuid' }` →
 * `string[]`).
 */
export interface RpcSetofReturn {
  readonly setof: string;
}

/**
 * Return type for an RPC function: a column type, `'void'`, a row set
 * (`{ table: { col: 'type' } }`) or a set of rows of a table / values of a
 * type (`{ setof: 'bookings' }`).
 */
export type RpcReturnType = ColumnType | 'void' | RpcTableReturn | RpcSetofReturn;

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

  /** Return type: a column type, `'void'`, `{ table: {...} }` or `{ setof: '...' }` */
  readonly returns?: RpcReturnType;

  /** PL/pgSQL or SQL function body (without CREATE FUNCTION wrapper) */
  readonly body?: string;

  /** Function language (default: plpgsql) */
  readonly language?: RpcLanguage;

  /** Security context (default: invoker) */
  readonly security?: RpcSecurity;

  /**
   * Volatility (default `'volatile'`). Declare `'stable'` for read-only
   * functions used inside RLS policies: Postgres can then evaluate them once
   * per query instead of once per row.
   */
  readonly volatility?: RpcVolatility;

  /** Alias of `volatility: 'immutable'` (kept for compatibility). */
  readonly immutable?: boolean;

  /**
   * Function configuration: `SET key = 'value'` clauses, e.g.
   * `{ row_security: 'off' }`. Keys are GUC names (`work_mem`,
   * `myapp.tenant`); each value is emitted as one quoted SQL literal.
   * `search_path` is always pinned to `pg_catalog, <schema>` by the generator;
   * a different `search_path` here is ignored (`validate` warns).
   */
  readonly set?: Readonly<Record<string, string>>;

  /**
   * `security: 'definer'` only: also let anonymous visitors call it (default
   * false). Definer RPCs bypass RLS, so AccessNexus revokes EXECUTE from PUBLIC and
   * `anon` and grants it to `authenticated` and `service_role`.
   */
  readonly allowAnon?: boolean;
}
