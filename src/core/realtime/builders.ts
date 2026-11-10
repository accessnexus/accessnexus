// ============================================
// AccessNexus - Realtime channel builder
// ============================================

import type { ChannelDef } from '../types/realtime.js';

/**
 * Define a private Realtime channel (Broadcast / Presence), passed to
 * `defineSchema(tables, { channels })`. Each rule becomes an RLS policy on
 * `realtime.messages` (receive = SELECT, send = INSERT); a missing rule means
 * nobody. With `table`, the topic parameter is that table's primary key and
 * every rule also requires that the user can SELECT the row.
 *
 * @example
 * ```ts
 * channels: {
 *   project_room: channel({
 *     topic: 'project:{id}',
 *     table: 'projects',
 *     broadcast: { receive: true, send: true },
 *     presence: { receive: true, send: true },
 *   }),
 *   announcements: channel({
 *     topic: 'announcements',
 *     broadcast: { receive: true, send: policy.hasRole('admin') },
 *   }),
 * }
 * ```
 */
export function channel(def: ChannelDef): ChannelDef {
  return def;
}
