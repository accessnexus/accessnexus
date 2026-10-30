// ============================================
// AccessNexus - `policies.all` expansion
// ============================================

import type { PolicyOperation, PolicyRule } from '../types/policy.js';

const OPERATIONS: readonly PolicyOperation[] = ['select', 'insert', 'update', 'delete'];

/**
 * Expand the `all` key of a table's `policies` into one rule per operation,
 * keeping every explicit per-operation key (`{ all: X, delete: Y }` →
 * select/insert/update X, delete Y). The result has no `all` key, so the
 * generator still emits one policy per operation (USING for select/delete,
 * WITH CHECK for insert, both for update). Anything that is not a plain
 * object is returned unchanged for `validate` to report.
 */
export function expandAllPolicy<T>(policies: T): T {
  if (!policies || typeof policies !== 'object' || Array.isArray(policies)) return policies;
  const input = policies as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(input, 'all')) return policies;
  const { all, ...rest } = input;
  if (all === undefined) return rest as T;
  const out: Record<string, unknown> = {};
  for (const op of OPERATIONS) {
    out[op] = rest[op] !== undefined ? rest[op] : (all as PolicyRule);
  }
  // Keep any other (invalid) key so validate still reports it.
  for (const [key, value] of Object.entries(rest)) {
    if (!(OPERATIONS as readonly string[]).includes(key)) out[key] = value;
  }
  return out as T;
}

/** A table definition with its `policies.all` expanded (see {@link expandAllPolicy}). */
export function withExpandedPolicies<T extends { policies?: unknown }>(def: T): T {
  if (!def || typeof def !== 'object' || def.policies === undefined) return def;
  const policies = expandAllPolicy(def.policies);
  return policies === def.policies ? def : { ...def, policies };
}
