import crypto from "node:crypto";
import type { RunOutcome, RunPhase } from "../domain/contracts";
import { computeEventDigest, hashSha256, stableJson } from "./digest";
import { SQLiteClient } from "./sqlite";
import type {
  ClaimedJob,
  ProviderJobStatus,
  RunEngineConfig,
  RunEngineStage,
  RunEvent,
  RunProjection,
  RunStartInput,
  StageHandlerResult,
  StageHandlers,
} from "./types";

type CreativeRunRow = {
  run_id: string;
  idempotency_key: string;
  phase: RunPhase;
  outcome: RunOutcome;
  input_payload: string;
  working_payload: string;
  result_payload: string | null;
  created_at: string;
  updated_at: string;
};

type ProviderJobRow = {
  job_id: string;
  run_id: string;
  stage: RunEngineStage;
  status: ProviderJobStatus;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string;
  lease_token: string | null;
  lease_expires_at: string | null;
  request_hash: string;
  response_hash: string | null;
  provider_ref: string | null;
  last_error: string | null;
};

type RunEventRow = {
  run_id: string;
  sequence: number;
  event_type: string;
  phase: RunPhase;
  outcome: RunOutcome;
  payload_json: string;
  prev_digest: string | null;
  digest: string;
  created_at: string;
};

const STAGE_ORDER: RunEngineStage[] = [
  "normalize",
  "validate_policy",
  "image_generation",
  "video_generation",
  "subtitles_export",
];

const STAGE_TO_PHASE: Record<RunEngineStage, RunPhase> = {
  normalize: "normalizing",
  validate_policy: "policy_validating",
  image_generation: "generating_images",
  video_generation: "generating_video",
  subtitles_export: "exporting",
};

function mapStageToPhase(stage: RunEngineStage): RunPhase {
  return STAGE_TO_PHASE[stage];
}

function nextStage(stage: RunEngineStage): RunEngineStage | null {
  const index = STAGE_ORDER.indexOf(stage);
  if (index < 0 || index === STAGE_ORDER.length - 1) {
    return null;
  }

  return STAGE_ORDER[index + 1] ?? null;
}

function toIsoTimestamp(inputDate = new Date()): string {
  return inputDate.toISOString();
}

function isBusyError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const sqliteError = error as { code?: string; message?: string };
  return (
    sqliteError.code === "SQLITE_BUSY" ||
    sqliteError.code === "SQLITE_LOCKED" ||
    sqliteError.message?.includes("SQLITE_BUSY") === true ||
    sqliteError.message?.includes("SQLITE_LOCKED") === true
  );
}

function backoffDelay(baseMs: number, attemptCount: number): number {
  return baseMs * 2 ** Math.max(attemptCount - 1, 0);
}

function randomToken(): string {
  return crypto.randomUUID();
}

function toEventModel(row: RunEventRow): RunEvent {
  return {
    runId: row.run_id,
    sequence: row.sequence,
    eventType: row.event_type,
    phase: row.phase,
    outcome: row.outcome,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    prevDigest: row.prev_digest,
    digest: row.digest,
    createdAt: row.created_at,
  };
}

function hashRequestPayload(runId: string, stage: RunEngineStage, payload: unknown): string {
  return hashSha256(`${runId}|${stage}|${stableJson(payload)}`);
}

function hashResponsePayload(value: unknown): string {
  return hashSha256(stableJson(value));
}

function toObjectPayload(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return { ...(payload as Record<string, unknown>) };
  }

  return {
    input_payload: payload,
  };
}

function mergeStageDataIntoPayload(
  payload: unknown,
  stage: RunEngineStage,
  stageData: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const nextPayload = toObjectPayload(payload);
  const data = stageData ?? {};
  const stageOutputs =
    nextPayload.stage_outputs && typeof nextPayload.stage_outputs === "object" && !Array.isArray(nextPayload.stage_outputs)
      ? ({ ...(nextPayload.stage_outputs as Record<string, unknown>) } as Record<string, unknown>)
      : {};

  stageOutputs[stage] = data;
  nextPayload.stage_outputs = stageOutputs;

  if (
    stage === "normalize" &&
    "normalize" in data &&
    data.normalize &&
    typeof data.normalize === "object" &&
    !Array.isArray(data.normalize)
  ) {
    const normalizeData = data.normalize as Record<string, unknown>;
    if (normalizeData.normalized_brief && typeof normalizeData.normalized_brief === "object") {
      nextPayload.normalized_brief = normalizeData.normalized_brief;
    }
  }

  if ("normalized_brief" in data && data.normalized_brief && typeof data.normalized_brief === "object") {
    nextPayload.normalized_brief = data.normalized_brief;
  }

  return nextPayload;
}

async function ensureWorkingPayloadColumn(client: SQLiteClient): Promise<void> {
  const columns = await client.all<{ name: string }>("PRAGMA table_info(creative_runs)");
  const hasWorkingPayload = columns.some((column) => column.name === "working_payload");

  if (!hasWorkingPayload) {
    await client.run("ALTER TABLE creative_runs ADD COLUMN working_payload TEXT");
    await client.run("UPDATE creative_runs SET working_payload = input_payload WHERE working_payload IS NULL");
  }
}

export type SQLiteRunEngine = {
  initialize: () => Promise<void>;
  close: () => Promise<void>;
  startRun: (input: RunStartInput) => Promise<{ runId: string; reused: boolean }>;
  claimNextJob: () => Promise<ClaimedJob | null>;
  renewLease: (jobId: string, leaseToken: string) => Promise<boolean>;
  recoverStaleLeases: () => Promise<number>;
  processClaim: (claim: ClaimedJob, handlers: StageHandlers) => Promise<void>;
  getRunProjection: (runId: string) => Promise<RunProjection>;
  getRunEvents: (runId: string) => Promise<RunEvent[]>;
  verifyRunEventChain: (runId: string) => Promise<{ valid: boolean; reason?: string }>;
};

export async function createSQLiteRunEngine(configuration: RunEngineConfig): Promise<SQLiteRunEngine> {
  const client = await SQLiteClient.open(configuration.sqlitePath);
  const leaseDurationMs = configuration.leaseDurationMs ?? 15_000;
  const busyTimeoutMs = configuration.busyTimeoutMs ?? 5_000;
  const busyRetryLimit = configuration.busyRetryLimit ?? 4;
  const busyRetryBaseMs = configuration.busyRetryBaseMs ?? 25;
  const retryBackoffBaseMs = configuration.retryBackoffBaseMs ?? 200;
  const maxAttemptsPerStage = configuration.maxAttemptsPerStage ?? 3;

  async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  async function withBusyRetry<T>(action: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= busyRetryLimit + 1; attempt += 1) {
      try {
        return await action();
      } catch (error) {
        if (!isBusyError(error) || attempt > busyRetryLimit) {
          throw error;
        }

        await sleep(backoffDelay(busyRetryBaseMs, attempt));
      }
    }

    throw new Error("unreachable busy retry path");
  }

  async function withTransaction<T>(action: () => Promise<T>): Promise<T> {
    return await withBusyRetry(async () => {
      await client.run("BEGIN IMMEDIATE TRANSACTION");
      try {
        const result = await action();
        await client.run("COMMIT");
        return result;
      } catch (error) {
        await client.run("ROLLBACK");
        throw error;
      }
    });
  }

  async function appendEvent(
    runId: string,
    eventType: string,
    phase: RunPhase,
    outcome: RunOutcome,
    payload: Record<string, unknown>,
    createdAt: string,
  ): Promise<void> {
    const previousEvent = await client.get<{ sequence: number; digest: string }>(
      "SELECT sequence, digest FROM run_events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1",
      [runId],
    );
    const sequence = (previousEvent?.sequence ?? 0) + 1;
    const prevDigest = previousEvent?.digest ?? null;
    const digest = computeEventDigest({
      runId,
      sequence,
      eventType,
      phase,
      outcome,
      payload,
      prevDigest,
    });

    await client.run(
      `INSERT INTO run_events (
        run_id,
        sequence,
        event_type,
        phase,
        outcome,
        payload_json,
        prev_digest,
        digest,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        sequence,
        eventType,
        phase,
        outcome,
        stableJson(payload),
        prevDigest,
        digest,
        createdAt,
      ],
    );
  }

  async function enqueueJob(
    runId: string,
    stage: RunEngineStage,
    payload: unknown,
    now: string,
  ): Promise<void> {
    const jobId = crypto.randomUUID();
    const requestHash = hashRequestPayload(runId, stage, payload);

    await client.run(
      `INSERT OR IGNORE INTO provider_jobs (
        job_id,
        run_id,
        stage,
        status,
        attempt_count,
        max_attempts,
        next_attempt_at,
        lease_token,
        lease_expires_at,
        request_hash,
        response_hash,
        provider_ref,
        last_error,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, 'queued', 0, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, ?, ?)`,
      [jobId, runId, stage, maxAttemptsPerStage, now, requestHash, now, now],
    );
  }

  async function failRun(
    runId: string,
    reason: string,
    now: string,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await client.run(
      `UPDATE creative_runs
         SET phase = 'failed',
             outcome = 'provider_failed',
             updated_at = ?,
             result_payload = ?
       WHERE run_id = ?`,
      [
        now,
        stableJson({
          reason,
          ...details,
        }),
        runId,
      ],
    );

    await appendEvent(
      runId,
      "run_failed",
      "failed",
      "provider_failed",
      {
        reason,
        ...details,
      },
      now,
    );
  }

  async function markJobSucceeded(
    claim: ClaimedJob,
    result: Exclude<StageHandlerResult, { type: "retryable_error" | "fatal_error" }>,
  ): Promise<void> {
    const now = toIsoTimestamp();
    await withTransaction(async () => {
      const currentJob = await client.get<ProviderJobRow>(
        "SELECT * FROM provider_jobs WHERE job_id = ?",
        [claim.jobId],
      );

      if (!currentJob) {
        return;
      }

      if (currentJob.status === "succeeded") {
        await appendEvent(
          claim.runId,
          "duplicate_delivery_ignored",
          mapStageToPhase(claim.stage),
          "none",
          {
            job_id: claim.jobId,
            stage: claim.stage,
            reason: "job already succeeded",
          },
          now,
        );
        return;
      }

      if (currentJob.lease_token !== claim.leaseToken || currentJob.status !== "in_progress") {
        await appendEvent(
          claim.runId,
          "duplicate_delivery_ignored",
          mapStageToPhase(claim.stage),
          "none",
          {
            job_id: claim.jobId,
            stage: claim.stage,
          },
          now,
        );
        return;
      }

      const responseHash = hashResponsePayload(result.data ?? {});
      await client.run(
        `UPDATE provider_jobs
            SET status = 'succeeded',
                lease_token = NULL,
                lease_expires_at = NULL,
                response_hash = ?,
                provider_ref = ?,
                updated_at = ?
          WHERE job_id = ?`,
        [responseHash, result.providerRef ?? null, now, claim.jobId],
      );

      await appendEvent(
        claim.runId,
        "job_succeeded",
        mapStageToPhase(claim.stage),
        "none",
        {
          job_id: claim.jobId,
          stage: claim.stage,
          provider_ref: result.providerRef ?? null,
          response_hash: responseHash,
          stage_output: result.data ?? null,
        },
        now,
      );

      const runRow = await client.get<CreativeRunRow>(
        "SELECT * FROM creative_runs WHERE run_id = ?",
        [claim.runId],
      );

      if (!runRow) {
        return;
      }

      const currentWorkingPayload = JSON.parse(runRow.working_payload ?? runRow.input_payload) as unknown;
      const mergedWorkingPayload = mergeStageDataIntoPayload(currentWorkingPayload, claim.stage, result.data);

      await client.run("UPDATE creative_runs SET working_payload = ?, updated_at = ? WHERE run_id = ?", [
        stableJson(mergedWorkingPayload),
        now,
        claim.runId,
      ]);

      const next = nextStage(claim.stage);
      if (!next) {
        const completedResult = {
          ...(result.data ?? {}),
          stages: STAGE_ORDER,
        };
        await client.run(
          `UPDATE creative_runs
             SET phase = 'completed',
                 outcome = 'ok',
                 result_payload = ?,
                 updated_at = ?
           WHERE run_id = ?`,
          [stableJson(completedResult), now, claim.runId],
        );
        await appendEvent(claim.runId, "run_completed", "completed", "ok", completedResult, now);
        return;
      }

      await enqueueJob(claim.runId, next, mergedWorkingPayload, now);
      await client.run(
        "UPDATE creative_runs SET phase = ?, updated_at = ? WHERE run_id = ?",
        [mapStageToPhase(next), now, claim.runId],
      );
      await appendEvent(
        claim.runId,
        "job_enqueued",
        mapStageToPhase(next),
        "none",
        {
          stage: next,
        },
        now,
      );
    });
  }

  async function scheduleRetry(
    claim: ClaimedJob,
    reason: string,
    providerRef?: string,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    const now = toIsoTimestamp();
    await withTransaction(async () => {
      const currentJob = await client.get<ProviderJobRow>(
        "SELECT * FROM provider_jobs WHERE job_id = ?",
        [claim.jobId],
      );

      if (!currentJob) {
        return;
      }

      if (currentJob.lease_token !== claim.leaseToken || currentJob.status !== "in_progress") {
        return;
      }

      if (currentJob.attempt_count >= currentJob.max_attempts) {
        await client.run(
          `UPDATE provider_jobs
              SET status = 'failed',
                  lease_token = NULL,
                  lease_expires_at = NULL,
                  last_error = ?,
                  response_hash = ?,
                  provider_ref = COALESCE(?, provider_ref),
                  updated_at = ?
            WHERE job_id = ?`,
          [reason, hashResponsePayload({ reason, ...details }), providerRef ?? null, now, claim.jobId],
        );

        await appendEvent(
          claim.runId,
          "job_failed",
          "failed",
          "provider_failed",
          {
            job_id: claim.jobId,
            stage: claim.stage,
            reason,
            provider_ref: providerRef ?? null,
            exhausted_retries: true,
            ...details,
          },
          now,
        );

        await failRun(claim.runId, reason, now, {
          stage: claim.stage,
          job_id: claim.jobId,
          provider_ref: providerRef ?? null,
          ...details,
        });
        return;
      }

      const delay = backoffDelay(retryBackoffBaseMs, currentJob.attempt_count);
      const retryAt = toIsoTimestamp(new Date(Date.now() + delay));
      await client.run(
          `UPDATE provider_jobs
            SET status = 'retrying',
                lease_token = NULL,
                lease_expires_at = NULL,
                next_attempt_at = ?,
                last_error = ?,
                provider_ref = COALESCE(?, provider_ref),
                updated_at = ?
          WHERE job_id = ?`,
        [retryAt, reason, providerRef ?? null, now, claim.jobId],
      );

      await appendEvent(
        claim.runId,
        "job_retry_scheduled",
        mapStageToPhase(claim.stage),
        "none",
        {
          job_id: claim.jobId,
          stage: claim.stage,
          reason,
          provider_ref: providerRef ?? null,
          retry_at: retryAt,
          ...details,
        },
        now,
      );
    });
  }

  async function markTerminalOutcome(
    claim: ClaimedJob,
    result: Extract<StageHandlerResult, { type: "terminal_outcome" }>,
  ): Promise<void> {
    const now = toIsoTimestamp();

    await withTransaction(async () => {
      const currentJob = await client.get<ProviderJobRow>(
        "SELECT * FROM provider_jobs WHERE job_id = ?",
        [claim.jobId],
      );

      if (!currentJob) {
        return;
      }

      if (currentJob.lease_token !== claim.leaseToken || currentJob.status !== "in_progress") {
        return;
      }

      const responsePayload = {
        reason: result.reason,
        outcome: result.outcome,
        stage_output: result.data ?? null,
      };

      await client.run(
        `UPDATE provider_jobs
            SET status = 'succeeded',
                lease_token = NULL,
                lease_expires_at = NULL,
                response_hash = ?,
                provider_ref = ?,
                updated_at = ?
          WHERE job_id = ?`,
        [hashResponsePayload(responsePayload), result.providerRef ?? null, now, claim.jobId],
      );

      await appendEvent(
        claim.runId,
        "job_succeeded",
        mapStageToPhase(claim.stage),
        "none",
        {
          job_id: claim.jobId,
          stage: claim.stage,
          provider_ref: result.providerRef ?? null,
          response_hash: hashResponsePayload(responsePayload),
          stage_output: result.data ?? null,
        },
        now,
      );

      await client.run(
        `UPDATE creative_runs
           SET phase = 'failed',
               outcome = ?,
               updated_at = ?,
               result_payload = ?
         WHERE run_id = ?`,
        [
          result.outcome,
          now,
          stableJson({
            reason: result.reason,
            stage: claim.stage,
            ...result.data,
          }),
          claim.runId,
        ],
      );

      await appendEvent(
        claim.runId,
        "run_terminated",
        "failed",
        result.outcome,
        {
          stage: claim.stage,
          reason: result.reason,
          stage_output: result.data ?? null,
        },
        now,
      );
    });
  }

  async function verifyRunEventChain(runId: string): Promise<{ valid: boolean; reason?: string }> {
    const rows = await client.all<RunEventRow>(
      "SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence ASC",
      [runId],
    );

    let previousDigest: string | null = null;
    let expectedSequence = 1;

    for (const row of rows) {
      if (row.sequence !== expectedSequence) {
        return {
          valid: false,
          reason: `non-monotonic event sequence at ${row.sequence}; expected ${expectedSequence}`,
        };
      }

      if ((row.prev_digest ?? null) !== previousDigest) {
        return {
          valid: false,
          reason: `prev_digest mismatch at sequence ${row.sequence}`,
        };
      }

      const digest = computeEventDigest({
        runId: row.run_id,
        sequence: row.sequence,
        eventType: row.event_type,
        phase: row.phase,
        outcome: row.outcome,
        payload: JSON.parse(row.payload_json) as Record<string, unknown>,
        prevDigest: row.prev_digest,
      });

      if (digest !== row.digest) {
        return {
          valid: false,
          reason: `digest mismatch at sequence ${row.sequence}`,
        };
      }

      previousDigest = row.digest;
      expectedSequence += 1;
    }

    return { valid: true };
  }

  async function getRunEvents(runId: string): Promise<RunEvent[]> {
    const rows = await client.all<RunEventRow>(
      "SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence ASC",
      [runId],
    );

    return rows.map(toEventModel);
  }

  return {
    initialize: async () => {
      await client.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;
        PRAGMA busy_timeout=${busyTimeoutMs};
        PRAGMA foreign_keys=ON;
        PRAGMA trusted_schema=OFF;

        CREATE TABLE IF NOT EXISTS creative_runs (
          run_id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          phase TEXT NOT NULL,
          outcome TEXT NOT NULL,
          input_payload TEXT NOT NULL,
          working_payload TEXT,
          result_payload TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS run_events (
          run_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          phase TEXT NOT NULL,
          outcome TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          prev_digest TEXT,
          digest TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, sequence),
          FOREIGN KEY (run_id) REFERENCES creative_runs(run_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS provider_jobs (
          job_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          stage TEXT NOT NULL,
          status TEXT NOT NULL,
          attempt_count INTEGER NOT NULL,
          max_attempts INTEGER NOT NULL,
          next_attempt_at TEXT NOT NULL,
          lease_token TEXT,
          lease_expires_at TEXT,
          request_hash TEXT NOT NULL,
          response_hash TEXT,
          provider_ref TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (run_id, stage),
          FOREIGN KEY (run_id) REFERENCES creative_runs(run_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_provider_jobs_claim
          ON provider_jobs (status, next_attempt_at, lease_expires_at, created_at);
      `);

      await ensureWorkingPayloadColumn(client);
      await client.run("UPDATE creative_runs SET working_payload = input_payload WHERE working_payload IS NULL");
    },

    close: async () => {
      await client.close();
    },

    startRun: async (input) => {
      const now = toIsoTimestamp();
      return await withTransaction(async () => {
        const existing = await client.get<{ run_id: string }>(
          "SELECT run_id FROM creative_runs WHERE idempotency_key = ?",
          [input.idempotencyKey],
        );
        if (existing) {
          return {
            runId: existing.run_id,
            reused: true,
          };
        }

        const runId = crypto.randomUUID();
        await client.run(
          `INSERT INTO creative_runs (
             run_id,
             idempotency_key,
             phase,
             outcome,
             input_payload,
             working_payload,
             result_payload,
             created_at,
             updated_at
           ) VALUES (?, ?, 'submitted', 'none', ?, ?, NULL, ?, ?)`,
          [runId, input.idempotencyKey, stableJson(input.payload), stableJson(input.payload), now, now],
        );

        await appendEvent(runId, "run_submitted", "submitted", "none", { idempotency_key: input.idempotencyKey }, now);
        await enqueueJob(runId, "normalize", input.payload, now);
        await appendEvent(
          runId,
          "job_enqueued",
          "normalizing",
          "none",
          {
            stage: "normalize",
          },
          now,
        );
        await client.run("UPDATE creative_runs SET phase = 'normalizing', updated_at = ? WHERE run_id = ?", [now, runId]);

        return {
          runId,
          reused: false,
        };
      });
    },

    claimNextJob: async () => {
      const now = toIsoTimestamp();
      const leaseToken = randomToken();
      const leaseExpiresAt = toIsoTimestamp(new Date(Date.now() + leaseDurationMs));

      return await withTransaction(async () => {
        const job = await client.get<ProviderJobRow>(
          `SELECT * FROM provider_jobs
             WHERE status IN ('queued', 'retrying')
               AND next_attempt_at <= ?
               AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
             ORDER BY created_at ASC
             LIMIT 1`,
          [now, now],
        );

        if (!job) {
          return null;
        }

        const updateResult = await client.run(
          `UPDATE provider_jobs
              SET status = 'in_progress',
                  attempt_count = attempt_count + 1,
                  lease_token = ?,
                  lease_expires_at = ?,
                  updated_at = ?
            WHERE job_id = ?
              AND status IN ('queued', 'retrying')`,
          [leaseToken, leaseExpiresAt, now, job.job_id],
        );

        if (updateResult.changes === 0) {
          return null;
        }

        await client.run(
          "UPDATE creative_runs SET phase = ?, updated_at = ? WHERE run_id = ?",
          [mapStageToPhase(job.stage), now, job.run_id],
        );
        await appendEvent(
          job.run_id,
          "job_claimed",
          mapStageToPhase(job.stage),
          "none",
          {
            job_id: job.job_id,
            stage: job.stage,
            lease_token: leaseToken,
            lease_expires_at: leaseExpiresAt,
          },
          now,
        );

        return {
          jobId: job.job_id,
          runId: job.run_id,
          stage: job.stage,
          leaseToken,
          leaseExpiresAt,
          attemptCount: job.attempt_count + 1,
          maxAttempts: job.max_attempts,
          requestHash: job.request_hash,
        } satisfies ClaimedJob;
      });
    },

    renewLease: async (jobId, leaseToken) => {
      const nextLeaseExpiresAt = toIsoTimestamp(new Date(Date.now() + leaseDurationMs));
      const updateResult = await withBusyRetry(async () =>
        await client.run(
          `UPDATE provider_jobs
             SET lease_expires_at = ?,
                 updated_at = ?
           WHERE job_id = ?
             AND lease_token = ?
             AND status = 'in_progress'`,
          [nextLeaseExpiresAt, toIsoTimestamp(), jobId, leaseToken],
        ),
      );

      return updateResult.changes > 0;
    },

    recoverStaleLeases: async () => {
      const now = toIsoTimestamp();

      return await withTransaction(async () => {
        const stale = await client.all<ProviderJobRow>(
          `SELECT * FROM provider_jobs
             WHERE status = 'in_progress'
               AND lease_expires_at IS NOT NULL
               AND lease_expires_at < ?`,
          [now],
        );

        for (const job of stale) {
          await client.run(
            `UPDATE provider_jobs
                SET status = 'retrying',
                    lease_token = NULL,
                    lease_expires_at = NULL,
                    next_attempt_at = ?,
                    updated_at = ?
              WHERE job_id = ?`,
            [now, now, job.job_id],
          );
          await appendEvent(
            job.run_id,
            "stale_lease_recovered",
            mapStageToPhase(job.stage),
            "none",
            {
              job_id: job.job_id,
              stage: job.stage,
            },
            now,
          );
        }

        return stale.length;
      });
    },

    processClaim: async (claim, handlers) => {
      const run = await client.get<CreativeRunRow>("SELECT * FROM creative_runs WHERE run_id = ?", [claim.runId]);

      if (!run) {
        return;
      }

      const payload = JSON.parse(run.working_payload ?? run.input_payload) as unknown;
      const stageHandler = handlers[claim.stage];

      const result = await stageHandler({
        runId: claim.runId,
        stage: claim.stage,
        attemptCount: claim.attemptCount,
        payload,
      });

      if (result.type === "success") {
        await markJobSucceeded(claim, result);
        return;
      }

      if (result.type === "terminal_outcome") {
        await markTerminalOutcome(claim, result);
        return;
      }

      if (result.type === "retryable_error") {
        await scheduleRetry(claim, result.reason, result.providerRef, result.details ?? {});
        return;
      }

      const now = toIsoTimestamp();
      await withTransaction(async () => {
        await client.run(
          `UPDATE provider_jobs
              SET status = 'failed',
                  lease_token = NULL,
                  lease_expires_at = NULL,
                  last_error = ?,
                  response_hash = ?,
                  provider_ref = COALESCE(?, provider_ref),
                  updated_at = ?
            WHERE job_id = ?
              AND lease_token = ?`,
          [
            result.reason,
            hashResponsePayload({ reason: result.reason, ...(result.details ?? {}) }),
            result.providerRef ?? null,
            now,
            claim.jobId,
            claim.leaseToken,
          ],
        );
        await appendEvent(
          claim.runId,
          "job_failed",
          "failed",
          "provider_failed",
          {
            job_id: claim.jobId,
            stage: claim.stage,
            reason: result.reason,
            provider_ref: result.providerRef ?? null,
            fatal: true,
            ...(result.details ?? {}),
          },
          now,
        );
        await failRun(claim.runId, result.reason, now, {
          stage: claim.stage,
          job_id: claim.jobId,
          provider_ref: result.providerRef ?? null,
          fatal: true,
          ...(result.details ?? {}),
        });
      });
    },

    getRunProjection: async (runId) => {
      const digestCheck = await verifyRunEventChain(runId);
      if (!digestCheck.valid) {
        throw new Error(`run ${runId} event chain invalid: ${digestCheck.reason}`);
      }

      const runRow = await client.get<CreativeRunRow>("SELECT * FROM creative_runs WHERE run_id = ?", [runId]);
      if (!runRow) {
        throw new Error(`run ${runId} not found`);
      }

      const events = await getRunEvents(runId);
      const jobs = await client.all<ProviderJobRow>(
        "SELECT * FROM provider_jobs WHERE run_id = ? ORDER BY created_at ASC",
        [runId],
      );

      const completedStages = jobs
        .filter((job) => job.status === "succeeded")
        .map((job) => job.stage);

      return {
        runId: runRow.run_id,
        idempotencyKey: runRow.idempotency_key,
        phase: runRow.phase,
        outcome: runRow.outcome,
        createdAt: runRow.created_at,
        updatedAt: runRow.updated_at,
        result: runRow.result_payload
          ? (JSON.parse(runRow.result_payload) as Record<string, unknown>)
          : null,
        provenance: {
          completedStages,
          providerJobs: jobs.map((job) => ({
            jobId: job.job_id,
            stage: job.stage,
            status: job.status,
            attemptCount: job.attempt_count,
            maxAttempts: job.max_attempts,
            requestHash: job.request_hash,
            responseHash: job.response_hash,
            providerRef: job.provider_ref,
            lastError: job.last_error,
            nextAttemptAt: job.next_attempt_at,
            leaseToken: job.lease_token,
            leaseExpiresAt: job.lease_expires_at,
          })),
        },
        events,
      };
    },

    getRunEvents,
    verifyRunEventChain,
  };
}
