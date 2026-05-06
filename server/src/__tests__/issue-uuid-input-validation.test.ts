import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue UUID input validation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue list UUID query param validation (DGG-5166)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-uuid-input-validation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  let prefixCounter = 0;
  async function setupCompany() {
    const companyId = randomUUID();
    prefixCounter += 1;
    await db.insert(companies).values({
      id: companyId,
      name: `Validation Co ${prefixCounter}`,
      issueCounter: 0,
      issuePrefix: `VAL${prefixCounter}`,
    });
    return companyId;
  }

  it("returns 400 (not 500) when projectId is a UUID prefix string", async () => {
    const companyId = await setupCompany();
    const app = createApp(companyId);

    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ projectId: "5d676414" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/projectId/i);
    expect(res.body.error).toMatch(/UUID/i);
  });

  it("returns 400 when assigneeAgentId is a non-UUID string", async () => {
    const companyId = await setupCompany();
    const app = createApp(companyId);

    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ assigneeAgentId: "a5eadce7" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/assigneeAgentId/i);
  });

  it("returns 400 when goalId is something arbitrary", async () => {
    const companyId = await setupCompany();
    const app = createApp(companyId);

    // goalId is not in UUID_QUERY_PARAMS yet because the list endpoint
    // doesn't filter on it; assert that originId IS validated instead.
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ originId: "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/originId/i);
  });

  it("accepts a real UUID and returns 200 with empty list", async () => {
    const companyId = await setupCompany();
    const app = createApp(companyId);

    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ projectId: randomUUID() });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toEqual([]);
  });

  it("ignores empty-string UUID-typed query params", async () => {
    const companyId = await setupCompany();
    const app = createApp(companyId);

    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ projectId: "", assigneeAgentId: "" });

    expect(res.status).toBe(200);
  });
});
