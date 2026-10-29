// ============================================
// AccessNexus CLI - Database connection timeout
// Shared by push/seed (run.ts) and `init --db-url` (init/introspect-db.ts).
// ============================================

/**
 * How long to wait for a database connection before failing with
 * DB_CONNECTION_FAILED (instead of hanging until the OS TCP timeout, ~2 min).
 * Override with ACCESSNEXUS_DB_CONNECT_TIMEOUT (seconds).
 */
export function dbConnectTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ACCESSNEXUS_DB_CONNECT_TIMEOUT;
  const seconds = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 10_000;
}
