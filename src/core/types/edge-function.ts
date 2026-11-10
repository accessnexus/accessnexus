// ============================================
// AccessNexus - Edge Function Types
// Typed, validated Supabase Edge Functions declared in the schema
// ============================================

/**
 * Who may call an Edge Function — the `auth` option of `withSupabase`
 * (`@supabase/server`):
 * - `'user'`: a signed-in user's JWT; `ctx.supabase` runs as that user (RLS applies);
 * - `'publishable'`: any request with a publishable key (no user needed);
 * - `'secret'`: server-to-server callers holding a secret key;
 * - `'none'`: anyone (webhooks); the gateway's JWT check is turned off.
 * An array accepts any of the listed modes (`'none'` last).
 */
export type EdgeFunctionAuth = 'user' | 'publishable' | 'secret' | 'none';

/**
 * Input / output fields: field name → column type string (`'uuid'`, `'text?'`,
 * `"enum('a','b')"`, `'jsonb'`, `'int[]'`, ...). `?` makes a field optional
 * (and nullable).
 */
export type EdgeFunctionFields = Record<string, string>;

/** An Edge Function declared with `edgeFunction()`. */
export interface EdgeFunctionDef {
  /** Who may call it (default `'user'`). */
  readonly auth?: EdgeFunctionAuth | readonly EdgeFunctionAuth[];
  /**
   * JSON body fields. The generated wrapper rejects any other body with 400
   * before your handler runs. Omit for a function that takes no input.
   */
  readonly input?: EdgeFunctionFields;
  /**
   * Response: an object of fields, a single column type, or `'void'` (no
   * body). Omit for an untyped (`unknown`) response.
   */
  readonly output?: EdgeFunctionFields | string;
}
