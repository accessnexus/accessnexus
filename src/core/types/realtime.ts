// ============================================
// AccessNexus - Realtime Types
// Postgres Changes publication + Broadcast/Presence authorization
// ============================================

import type { PolicyRule } from './policy.js';

/**
 * Realtime (Postgres Changes) for a table: `true` adds it to the
 * `supabase_realtime` publication, `false` removes it, leaving the key out
 * leaves the publication as it is (e.g. enabled in the dashboard).
 */
export type TableRealtime = boolean | {
  /**
   * `REPLICA IDENTITY` of the table (default `'default'`). `'full'` makes
   * UPDATE/DELETE events carry the old row — only on tables without RLS:
   * with RLS on, Supabase sends just the primary key in `old` anyway.
   */
  readonly replicaIdentity?: 'default' | 'full';
};

/**
 * Who may receive or send on a channel:
 * - `true`: any signed-in user (and, with `table`, only when they can SELECT
 *   the row the topic names);
 * - `false` / omitted: nobody (no policy);
 * - a rule built from `policy.isAuthenticated()`, `policy.public()`,
 *   `policy.none()`, `policy.hasRole(role)`, `policy.custom(sql)` and the
 *   `policy.any` / `policy.all` combinators. `policy.custom` may use
 *   `{<param>}` for the topic parameter (as text), e.g.
 *   `policy.custom("{id} = (SELECT auth.uid())::text")`.
 */
export type ChannelRule = boolean | PolicyRule;

/** Receive/send rules of one Realtime extension (broadcast or presence). */
export interface ChannelAccess {
  /** Receive messages (broadcast) / see who is present (presence): SELECT on realtime.messages. */
  readonly receive?: ChannelRule;
  /** Send messages (broadcast) / track your presence (presence): INSERT on realtime.messages. */
  readonly send?: ChannelRule;
}

/**
 * A private Realtime channel (Broadcast and/or Presence) and who may use it.
 * Rules become RLS policies on `realtime.messages`.
 */
export interface ChannelDef {
  /**
   * Topic pattern: a fixed topic (`'lobby'`) or a prefix plus one trailing
   * parameter (`'project:{id}'`). Letters, digits and `:_.-` only.
   */
  readonly topic: string;
  /**
   * Table whose primary key the topic parameter is. Every rule of the channel
   * then also requires that the user can SELECT that row (RLS of the table
   * decides), so a channel is never wider than the row it belongs to.
   */
  readonly table?: string;
  readonly broadcast?: ChannelAccess;
  readonly presence?: ChannelAccess;
}
