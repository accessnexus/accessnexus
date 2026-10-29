// ============================================
// AccessNexus - RPC Builder
// Fluent API for defining PostgreSQL functions
// ============================================

import type { RpcArg, RpcDef, RpcLanguage, RpcReturnType, RpcSecurity, RpcVolatility } from '../types/rpc.js';

/**
 * Define an RPC (PostgreSQL function), passed to `defineSchema(tables, { rpcs })`.
 * With a `body`, AccessNexus emits `CREATE OR REPLACE FUNCTION` (default
 * `plpgsql`, `SECURITY INVOKER`, pinned `search_path`) and a typed
 * `client.rpc.<name>()`; `security: 'definer'` bypasses RLS — check
 * `(SELECT auth.uid())` inside the body yourself. A definer RPC is callable by
 * `authenticated` (and `service_role`) only; `allowAnon: true` adds `anon`.
 *
 * @example
 * ```ts
 * // Database mode — marker only, types from Database
 * rpc()
 *
 * // Signature only — typed client, no SQL generation
 * rpc({ args: { user_id: 'uuid' }, returns: 'jsonb' })
 *
 * // Full definition — generates SQL + typed client
 * rpc({
 *   args: { user_id: 'uuid' },
 *   returns: 'jsonb',
 *   body: `RETURN (SELECT json_build_object('count', count(*)) FROM orders);`,
 * })
 * ```
 */
export function rpc(config?: {
  args?: Record<string, RpcArg>;
  returns?: RpcReturnType;
  body?: string;
  language?: RpcLanguage;
  security?: RpcSecurity;
  volatility?: RpcVolatility;
  /** Alias of `volatility: 'immutable'`. */
  immutable?: boolean;
  set?: Record<string, string>;
  allowAnon?: boolean;
}): RpcDef {
  return {
    _rpc: true,
    ...config,
  } as RpcDef;
}
