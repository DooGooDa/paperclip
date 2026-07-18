import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { ADVISORY_LOCK_KEYS, runWithAdvisoryLock } from "../services/advisory-lock.ts";

// The postgres-js client (drizzle's `$client`) — one per simulated server
// instance. `postgres` is not a direct dependency of the server package, so we
// reach the client through @paperclipai/db's createDb.
type PgClient = ReturnType<typeof createDb>["$client"];

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres advisory-lock tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("runWithAdvisoryLock singleton guard", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let connectionString = "";
  const openClients: PgClient[] = [];

  // Each client is an independent postgres-js pool → an independent set of
  // sessions, simulating a separate server instance in a multi-instance deploy.
  function newClient(): PgClient {
    const client = createDb(connectionString).$client;
    openClients.push(client);
    return client;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-advisory-lock-");
    connectionString = tempDb.connectionString;
  }, 20_000);

  afterAll(async () => {
    await Promise.all(openClients.map((client) => client.end({ timeout: 5 }).catch(() => {})));
    await tempDb?.cleanup();
  });

  it("runs the job and returns acquired=true when the key is free, then releases", async () => {
    const sql = newClient();
    let ran = false;

    const result = await runWithAdvisoryLock(sql, ADVISORY_LOCK_KEYS.heartbeatTick, async () => {
      ran = true;
    });

    expect(result).toEqual({ acquired: true });
    expect(ran).toBe(true);

    // The lock must be released after the job: a fresh attempt on the same key
    // acquires again (proves we don't leak the lock on the pooled connection).
    const again = await runWithAdvisoryLock(sql, ADVISORY_LOCK_KEYS.heartbeatTick, async () => {});
    expect(again.acquired).toBe(true);
  });

  it("no-ops (acquired=false, job not run) while another instance holds the key", async () => {
    const key = ADVISORY_LOCK_KEYS.heartbeatReaper;
    const holderSql = newClient();
    const contenderSql = newClient();
    const ran: string[] = [];

    let releaseHolder!: () => void;
    const holderHolding = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderEntered!: () => void;
    const holderEnteredPromise = new Promise<void>((resolve) => {
      holderEntered = resolve;
    });

    const holder = runWithAdvisoryLock(holderSql, key, async () => {
      ran.push("holder");
      holderEntered();
      await holderHolding;
    });

    // Ensure the holder actually holds the lock before the contender attempts.
    await holderEnteredPromise;

    const contender = await runWithAdvisoryLock(contenderSql, key, async () => {
      ran.push("contender");
    });

    expect(contender).toEqual({ acquired: false });
    expect(ran).toEqual(["holder"]);

    releaseHolder();
    expect(await holder).toEqual({ acquired: true });
    expect(ran).toEqual(["holder"]);
  });

  it("auto-releases a session-level lock when the holding connection dies", async () => {
    // Dedicated key outside the job registry so this probe cannot collide with
    // other tests in the file.
    const key = 0x5043dead;
    const holderClient = newClient();
    const probeClient = newClient();

    // Pin the probe connection so its acquire/unlock stay on one session. The
    // holder acquires on its pool directly (no reserve) so ending the pool has
    // no checked-out connection to wait on — it closes the idle lock-holding
    // session promptly, which is exactly the "connection death" we want to test.
    const probeConn = await probeClient.reserve();

    const [held] = await holderClient<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(${key}) AS acquired
    `;
    expect(held.acquired).toBe(true);

    // A different session is refused while the holder is alive.
    const [blocked] = await probeConn<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(${key}) AS acquired
    `;
    expect(blocked.acquired).toBe(false);

    // Kill the holder pool → the session holding the lock dies → Postgres
    // releases its session-level advisory locks.
    await holderClient.end({ timeout: 5 });

    // The probe can now acquire. Release is effectively immediate; poll briefly
    // to stay robust against backend teardown latency.
    let acquiredAfter = false;
    for (let attempt = 0; attempt < 100 && !acquiredAfter; attempt++) {
      const [row] = await probeConn<{ acquired: boolean }[]>`
        SELECT pg_try_advisory_lock(${key}) AS acquired
      `;
      acquiredAfter = row.acquired === true;
      if (!acquiredAfter) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(acquiredAfter).toBe(true);

    await probeConn`SELECT pg_advisory_unlock(${key})`;
    probeConn.release();
  });

  it("mutation: guarded runs enter once; a lock-defeated copy lets every instance run", async () => {
    const key = ADVISORY_LOCK_KEYS.duplicateSessionDetector;
    const contenders = [newClient(), newClient(), newClient()];

    async function countConcurrentEntries(run: typeof runWithAdvisoryLock): Promise<number> {
      let entered = 0;
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let firstEntered!: () => void;
      const firstEnteredPromise = new Promise<void>((resolve) => {
        firstEntered = resolve;
      });

      const jobs = contenders.map((sql) =>
        run(sql, key, async () => {
          entered += 1;
          firstEntered();
          await gate; // hold so overlapping entrants stay concurrent
        }),
      );

      await firstEnteredPromise;
      // Let every losing attempt try (and be refused) before releasing.
      await new Promise((resolve) => setTimeout(resolve, 100));
      releaseGate();
      await Promise.all(jobs);
      return entered;
    }

    // GREEN: the real guard admits exactly one of three concurrent instances.
    const guardedEntries = await countConcurrentEntries(runWithAdvisoryLock);
    expect(guardedEntries).toBe(1);

    // Mutation — defeat the lock check with a copy that always runs the job. A
    // tautological test would still report 1; instead this must show ALL three
    // instances running, proving the advisory lock (not the test) is what makes
    // the job a singleton.
    const runWithoutLock: typeof runWithAdvisoryLock = async (_sql, _key, job) => {
      await job();
      return { acquired: true };
    };
    const defeatedEntries = await countConcurrentEntries(runWithoutLock);
    expect(defeatedEntries).toBe(contenders.length);
  });
});
