import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sqlite3 from "sqlite3";
import {
  createMockStageHandlers,
  createSQLiteRunEngine,
  createStageHandlers,
  type StageHandler,
} from "@shared/index";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function openRawDatabase(sqlitePath: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(sqlitePath, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(db);
    });
  });
}

function rawRun(database: sqlite3.Database, sql: string, params: Array<string | number> = []): Promise<void> {
  return new Promise((resolve, reject) => {
    database.run(sql, params, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function closeRawDatabase(database: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    database.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

describe("sqlite-run-engine", () => {
  test("progresses happy-path run with persisted projection", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deal-pump-run-engine-"));
    const sqlitePath = path.join(tempRoot, "deal-pump.sqlite");
    const engine = await createSQLiteRunEngine({
      sqlitePath,
      leaseDurationMs: 250,
      retryBackoffBaseMs: 10,
    });
    await engine.initialize();

    const handlers = createMockStageHandlers();
    const started = await engine.startRun({
      idempotencyKey: "happy-path",
      payload: { brief_id: "fixture-happy" },
    });

    for (let index = 0; index < 100; index += 1) {
      const claim = await engine.claimNextJob();
      if (!claim) {
        await sleep(10);
        continue;
      }

      await engine.processClaim(claim, handlers);
      const projection = await engine.getRunProjection(started.runId);
      if (projection.phase === "completed") {
        break;
      }
    }

    const projection = await engine.getRunProjection(started.runId);
    expect(projection.phase).toBe("completed");
    expect(projection.outcome).toBe("ok");
    expect(projection.provenance.completedStages).toEqual([
      "normalize",
      "validate_policy",
      "image_generation",
      "video_generation",
      "subtitles_export",
    ]);
    expect(projection.events.every((event, index) => event.sequence === index + 1)).toBe(true);
    expect((await engine.verifyRunEventChain(started.runId)).valid).toBe(true);

    await engine.close();
  });

  test("recovers stale leases and reclaims work", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deal-pump-run-engine-"));
    const sqlitePath = path.join(tempRoot, "deal-pump.sqlite");
    const engine = await createSQLiteRunEngine({ sqlitePath, leaseDurationMs: 150 });
    await engine.initialize();

    const started = await engine.startRun({
      idempotencyKey: "stale-lease",
      payload: { brief_id: "fixture-stale-lease" },
    });
    const firstClaim = await engine.claimNextJob();
    expect(firstClaim).not.toBeNull();

    const rawDatabase = await openRawDatabase(sqlitePath);
    await rawRun(
      rawDatabase,
      "UPDATE provider_jobs SET lease_expires_at = ? WHERE job_id = ?",
      [new Date(Date.now() - 60_000).toISOString(), firstClaim?.jobId ?? ""],
    );
    await closeRawDatabase(rawDatabase);

    const recovered = await engine.recoverStaleLeases();
    expect(recovered).toBeGreaterThanOrEqual(1);

    const reclaimed = await engine.claimNextJob();
    expect(reclaimed?.runId).toBe(started.runId);
    expect(reclaimed?.jobId).toBe(firstClaim?.jobId);
    expect(reclaimed?.leaseToken).not.toBe(firstClaim?.leaseToken);

    await engine.close();
  });

  test("handles SQLITE_BUSY via retry wrapper", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deal-pump-run-engine-"));
    const sqlitePath = path.join(tempRoot, "deal-pump.sqlite");
    const engine = await createSQLiteRunEngine({
      sqlitePath,
      busyTimeoutMs: 5,
      busyRetryLimit: 10,
      busyRetryBaseMs: 20,
    });
    await engine.initialize();

    const rawDatabase = await openRawDatabase(sqlitePath);
    await rawRun(rawDatabase, "BEGIN IMMEDIATE TRANSACTION");

    const releasePromise = (async () => {
      await sleep(200);
      await rawRun(rawDatabase, "COMMIT");
      await closeRawDatabase(rawDatabase);
    })();

    const started = await engine.startRun({
      idempotencyKey: "sqlite-busy",
      payload: { brief_id: "fixture-sqlite-busy" },
    });

    expect(started.runId).toBeTruthy();
    await releasePromise;
    await engine.close();
  });

  test("supports retry/backoff and duplicate delivery idempotency", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deal-pump-run-engine-"));
    const sqlitePath = path.join(tempRoot, "deal-pump.sqlite");
    const engine = await createSQLiteRunEngine({
      sqlitePath,
      retryBackoffBaseMs: 5,
      leaseDurationMs: 200,
    });
    await engine.initialize();

    const handlers = createMockStageHandlers();
    const first = await engine.startRun({
      idempotencyKey: "duplicate-start",
      payload: {
        brief_id: "fixture-retry",
        mock_plan: {
          transient_failures: {
            image_generation: 1,
          },
        },
      },
    });
    const second = await engine.startRun({
      idempotencyKey: "duplicate-start",
      payload: { brief_id: "fixture-retry" },
    });

    expect(second.runId).toBe(first.runId);
    expect(second.reused).toBe(true);

    const normalizeClaim = await engine.claimNextJob();
    expect(normalizeClaim?.stage).toBe("normalize");

    if (!normalizeClaim) {
      throw new Error("Expected first claim for duplicate delivery scenario.");
    }

    await engine.processClaim(normalizeClaim, handlers);
    await engine.processClaim(normalizeClaim, handlers);

    for (let index = 0; index < 120; index += 1) {
      const claim = await engine.claimNextJob();
      if (!claim) {
        await sleep(10);
        continue;
      }

      await engine.processClaim(claim, handlers);
      const projection = await engine.getRunProjection(first.runId);
      if (projection.phase === "completed") {
        break;
      }
    }

    const projection = await engine.getRunProjection(first.runId);
    expect(projection.phase).toBe("completed");

    const imageJob = projection.provenance.providerJobs.find((job) => job.stage === "image_generation");
    expect(imageJob?.attemptCount).toBe(2);
    const retryEvent = projection.events.find((event) => event.eventType === "job_retry_scheduled");
    expect(retryEvent).toBeDefined();
    const duplicateIgnored = projection.events.find(
      (event) => event.eventType === "duplicate_delivery_ignored",
    );
    expect(duplicateIgnored).toBeDefined();

    await engine.close();
  });

  test("detects event-digest tampering", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deal-pump-run-engine-"));
    const sqlitePath = path.join(tempRoot, "deal-pump.sqlite");
    const engine = await createSQLiteRunEngine({ sqlitePath, retryBackoffBaseMs: 5 });
    await engine.initialize();

    const handlers = createMockStageHandlers();
    const started = await engine.startRun({
      idempotencyKey: "tamper",
      payload: { brief_id: "fixture-tamper" },
    });

    for (let index = 0; index < 100; index += 1) {
      const claim = await engine.claimNextJob();
      if (!claim) {
        await sleep(10);
        continue;
      }

      await engine.processClaim(claim, handlers);
      const projection = await engine.getRunProjection(started.runId);
      if (projection.phase === "completed") {
        break;
      }
    }

    const rawDatabase = await openRawDatabase(sqlitePath);
    await rawRun(
      rawDatabase,
      "UPDATE run_events SET payload_json = ? WHERE run_id = ? AND sequence = 2",
      ['{"tampered":true}', started.runId],
    );
    await closeRawDatabase(rawDatabase);

    await expect(engine.getRunProjection(started.runId)).rejects.toThrow("event chain invalid");
    const digestCheck = await engine.verifyRunEventChain(started.runId);
    expect(digestCheck.valid).toBe(false);

    await engine.close();
  });

  test("marks the run failed when a stage handler throws", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deal-pump-run-engine-"));
    const sqlitePath = path.join(tempRoot, "deal-pump.sqlite");
    const engine = await createSQLiteRunEngine({
      sqlitePath,
      leaseDurationMs: 250,
      retryBackoffBaseMs: 10,
    });
    await engine.initialize();

    const explodingNormalize: StageHandler = async () => {
      throw new Error("normalize exploded");
    };

    const handlers = createStageHandlers({
      normalize: explodingNormalize,
    });

    const started = await engine.startRun({
      idempotencyKey: "stage-throws",
      payload: { brief_id: "fixture-stage-throws" },
    });

    const claim = await engine.claimNextJob();
    expect(claim?.stage).toBe("normalize");

    if (!claim) {
      throw new Error("Expected normalize claim for thrown stage test.");
    }

    await expect(engine.processClaim(claim, handlers)).resolves.toBeUndefined();

    const projection = await engine.getRunProjection(started.runId);
    expect(projection.phase).toBe("failed");
    expect(projection.outcome).toBe("provider_failed");
    expect(String(projection.result?.reason)).toContain(
      "unexpected normalize stage exception: normalize exploded",
    );

    await engine.close();
  });
});
