import type { createDb } from "@paperclipai/db";

/**
 * The postgres-js client backing a drizzle database — drizzle exposes it as
 * `$client`. Typed transitively through @paperclipai/db because `postgres` is not
 * a direct dependency of this package.
 */
type Sql = ReturnType<typeof createDb>["$client"];

/**
 * Postgres session-level advisory-lock key registry.
 *
 * Each periodic singleton job owns a fixed, unique key. In a multi-instance
 * deployment (e.g. two machines running the same server) the job is wrapped in
 * `runWithAdvisoryLock` so that, per tick, exactly one instance acquires the
 * lock and runs the job while the others no-op. A single-instance deployment
 * (the current configuration) always acquires the lock, so behaviour is
 * unchanged.
 *
 * Keys are arbitrary integers but MUST stay globally unique across jobs:
 * `pg_advisory_lock` keys are global per database, so reusing a key would make
 * two unrelated jobs contend for the same lock. They live in a dedicated numeric
 * namespace (0x50430000 = "PC" << 16) to keep them clear of the
 * hashtext-derived `pg_advisory_xact_lock` keys used elsewhere (plugin
 * migrations, watchdog-dismiss dedup). Never reuse or renumber an existing key —
 * during a rolling deploy old and new instances briefly coexist, and unique keys
 * keep that transition safe.
 */
export const ADVISORY_LOCK_KEYS = {
  /** Heartbeat + routine scheduler tick (timer-driven run dispatch). */
  heartbeatTick: 0x50430001,
  /** Orphan reaper + persisted-work recovery chain. */
  heartbeatReaper: 0x50430002,
  /** Duplicate active issue-session detector (observation only, T5.4). */
  duplicateSessionDetector: 0x50430003,
} as const;

export type AdvisoryLockRunResult = { acquired: boolean };

/**
 * Run `job` iff this process can acquire the session-level advisory lock for
 * `lockKey`; otherwise no-op and return `{ acquired: false }`.
 *
 * Non-blocking: uses `pg_try_advisory_lock` (never the blocking
 * `pg_advisory_lock`), so a losing instance returns immediately instead of
 * queueing behind the holder.
 *
 * Connection handling: postgres-js pools connections, and a *session*-level
 * advisory lock is bound to the connection that took it — so the acquire and its
 * matching `pg_advisory_unlock` must run on the same session. We therefore
 * `reserve()` one connection for the acquire → job → unlock sequence and release
 * it afterwards. (The job itself uses the pool; the reserved connection only
 * holds the lock.)
 *
 * Release strategy: the lock is released explicitly with `pg_advisory_unlock`
 * once the job settles (success or throw). As a backstop, a session-level lock
 * is released automatically by Postgres when the owning connection dies, so a
 * crashed leader cannot wedge the job for other instances. We deliberately do
 * NOT hold the lock for the process lifetime: releasing every tick lets a
 * healthy instance take over immediately if the current holder stalls.
 */
export async function runWithAdvisoryLock(
  sql: Sql,
  lockKey: number,
  job: () => Promise<void>,
): Promise<AdvisoryLockRunResult> {
  const connection = await sql.reserve();
  try {
    const rows = await connection<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(${lockKey}) AS acquired
    `;
    if (rows[0]?.acquired !== true) {
      return { acquired: false };
    }
    try {
      await job();
      return { acquired: true };
    } finally {
      await connection`SELECT pg_advisory_unlock(${lockKey})`;
    }
  } finally {
    connection.release();
  }
}
