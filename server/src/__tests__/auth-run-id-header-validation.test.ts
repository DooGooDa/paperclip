import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";

function createSelectChain(rows: unknown[]) {
  return {
    from() {
      return {
        where() {
          return Promise.resolve(rows);
        },
      };
    },
  };
}

function createDb() {
  return {
    select: vi
      .fn()
      .mockImplementation(() => createSelectChain([])),
  } as any;
}

describe("actorMiddleware x-paperclip-run-id sanitization (DGG-5166)", () => {
  function buildApp() {
    const app = express();
    app.use(actorMiddleware(createDb(), { deploymentMode: "local_trusted" }));
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });
    return app;
  }

  it("accepts a valid UUID run id", async () => {
    const app = buildApp();
    const runId = "11111111-2222-3333-4444-555555555555";
    const res = await request(app)
      .get("/actor")
      .set("x-paperclip-run-id", runId);

    expect(res.status).toBe(200);
    // Local trusted mode keeps actor.type=board; runId attaches when present
    expect(res.body.runId).toBe(runId);
  });

  it("ignores non-UUID run id strings without 500ing downstream", async () => {
    const app = buildApp();
    const res = await request(app)
      .get("/actor")
      .set("x-paperclip-run-id", "kuromi-dgg-5158-dependabot-1778032937");

    expect(res.status).toBe(200);
    expect(res.body.runId).toBeUndefined();
  });

  it("ignores empty/whitespace run id header", async () => {
    const app = buildApp();
    const res = await request(app)
      .get("/actor")
      .set("x-paperclip-run-id", "   ");

    expect(res.status).toBe(200);
    expect(res.body.runId).toBeUndefined();
  });

  it("ignores GitHub Actions-style numeric run id", async () => {
    const app = buildApp();
    const res = await request(app)
      .get("/actor")
      .set("x-paperclip-run-id", "25374717109");

    expect(res.status).toBe(200);
    expect(res.body.runId).toBeUndefined();
  });
});
