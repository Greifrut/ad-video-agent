import type { RunOutcome, RunPhase } from "../domain/contracts";

export const RUN_ENGINE_STAGES = [
  "normalize",
  "validate_policy",
  "image_generation",
  "video_generation",
  "subtitles_export",
] as const;

export type RunEngineStage = (typeof RUN_ENGINE_STAGES)[number];

export const PROVIDER_JOB_STATUSES = [
  "queued",
  "in_progress",
  "retrying",
  "succeeded",
  "failed",
] as const;

export type ProviderJobStatus = (typeof PROVIDER_JOB_STATUSES)[number];

export type RunEngineConfig = {
  sqlitePath: string;
  leaseDurationMs?: number;
  busyTimeoutMs?: number;
  busyRetryLimit?: number;
  busyRetryBaseMs?: number;
  retryBackoffBaseMs?: number;
  maxAttemptsPerStage?: number;
  workerId?: string;
};

export type RunStartInput = {
  idempotencyKey: string;
  payload: unknown;
};

export type StartRunResult = {
  runId: string;
  reused: boolean;
};

export type ClaimedJob = {
  jobId: string;
  runId: string;
  stage: RunEngineStage;
  leaseToken: string;
  leaseExpiresAt: string;
  attemptCount: number;
  maxAttempts: number;
  requestHash: string;
};

export type StageHandlerContext = {
  runId: string;
  stage: RunEngineStage;
  attemptCount: number;
  payload: unknown;
};

export type StageHandlerResult =
  | { type: "success"; data?: Record<string, unknown>; providerRef?: string }
  | {
      type: "terminal_outcome";
      outcome: Extract<RunOutcome, "needs_clarification" | "policy_blocked">;
      reason: string;
      data?: Record<string, unknown>;
      providerRef?: string;
    }
  | {
      type: "retryable_error";
      reason: string;
      providerRef?: string;
      details?: Record<string, unknown>;
    }
  | {
      type: "fatal_error";
      reason: string;
      providerRef?: string;
      details?: Record<string, unknown>;
    };

export type StageHandler = (context: StageHandlerContext) => Promise<StageHandlerResult>;

export type StageHandlers = Record<RunEngineStage, StageHandler>;

export type RunEvent = {
  runId: string;
  sequence: number;
  eventType: string;
  phase: RunPhase;
  outcome: RunOutcome;
  payload: Record<string, unknown>;
  prevDigest: string | null;
  digest: string;
  createdAt: string;
};

export type RunProjection = {
  runId: string;
  idempotencyKey: string;
  phase: RunPhase;
  outcome: RunOutcome;
  createdAt: string;
  updatedAt: string;
  result: Record<string, unknown> | null;
  provenance: {
    completedStages: RunEngineStage[];
    providerJobs: Array<{
      jobId: string;
      stage: RunEngineStage;
      status: ProviderJobStatus;
      attemptCount: number;
      maxAttempts: number;
      requestHash: string;
      responseHash: string | null;
      providerRef: string | null;
      lastError: string | null;
      nextAttemptAt: string;
      leaseToken: string | null;
      leaseExpiresAt: string | null;
    }>;
  };
  events: RunEvent[];
};

export type VerifyDigestResult = {
  valid: boolean;
  reason?: string;
};
