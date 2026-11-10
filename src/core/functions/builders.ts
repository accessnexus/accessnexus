// ============================================
// AccessNexus - Edge Function builder
// ============================================

import type { EdgeFunctionDef } from '../types/edge-function.js';

/**
 * Declare a Supabase Edge Function, passed to `defineSchema(tables, { functions })`
 * under its name (`'invite-member'`). `generate` writes a typed, validated
 * wrapper (`supabase/functions/_shared/accessnexus.ts`, built on `withSupabase`
 * from `@supabase/server`), scaffolds `supabase/functions/<name>/index.ts` once,
 * sets `verify_jwt` in `supabase/config.toml`, and adds a typed
 * `client.functions.<camelName>(input)` to the SDK.
 *
 * @example
 * ```ts
 * functions: {
 *   'invite-member': edgeFunction({
 *     auth: 'user',
 *     input: { org_id: 'uuid', email: 'text', role: "enum('admin','member')" },
 *     output: { invitation_id: 'uuid' },
 *   }),
 *   'stripe-webhook': edgeFunction({ auth: 'none', output: 'void' }),
 * }
 * ```
 */
export function edgeFunction(def: EdgeFunctionDef = {}): EdgeFunctionDef {
  return def;
}
