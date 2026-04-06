"use client";

import {
  APPROVED_ASSET_BY_ID,
  type ApprovedAssetRecord,
} from "@shared/domain/approved-assets";
import type { RunOutcome, RunPhase } from "@shared/domain/contracts";
import { useEffect, useMemo, useState } from "react";
import {
  FIXTURE_SAMPLE_BRIEF,
  LIVE_SAMPLE_BRIEF,
  defaultFixtureModeForEnvironment,
  sampleBriefForMode,
} from "@/components/public-demo-config";

const PHASE_STEPS: Array<{
  phase: RunPhase;
  label: string;
  detail: string;
}> = [
  {
    phase: "submitted",
    label: "Submitted",
    detail: "The brief is queued and waiting for the run engine.",
  },
  {
    phase: "normalizing",
    label: "Normalizing",
    detail: "The freeform request is turned into the locked JSON schema.",
  },
  {
    phase: "policy_validating",
    label: "Asset selection",
    detail: "The structured script is matched to predefined scene assets.",
  },
  {
    phase: "generating_images",
    label: "Selecting stills",
    detail: "Pre-generated scene images are loaded from local assets.",
  },
  {
    phase: "generating_video",
    label: "Generating video",
    detail: "Animated clips are assembled from the approved lineage.",
  },
  {
    phase: "exporting",
    label: "Exporting",
    detail: "Subtitles, provenance, and final MP4 artifacts are written.",
  },
  {
    phase: "completed",
    label: "Completed",
    detail: "The final video and provenance are ready for review.",
  },
];

const TERMINAL_OUTCOMES = new Set<RunOutcome>([
  "ok",
  "needs_clarification",
  "policy_blocked",
  "provider_failed",
]);
const TERMINAL_PHASES = new Set<RunPhase>(["completed", "failed"]);
const POLL_INTERVAL_MS = 1250;

type StartRunResponse = {
  runId: string;
};

type ApiErrorResponse = {
  error?: {
    code?: string;
    message?: string;
    retryAfterSeconds?: number;
  };
};

type RunStatusPayload = {
  runId: string;
  phase: RunPhase;
  outcome: RunOutcome;
  errorCode?: string;
  errorMessage?: string;
  failureType?: string;
  providerReason?: string;
  providerReasonCode?: string;
  sceneId?: string;
  normalizedBrief?: unknown;
  selectedAssetIds?: string[];
  resultUrl?: string;
  provenanceUrl?: string;
};

type PromptRegistryEntry = {
  prompt_id?: string;
  version?: number;
  template_hash?: string;
  model?: string;
};

type PromptRegistryStageValue = PromptRegistryEntry | PromptRegistryEntry[];

type ProvenancePayload = {
  run_id?: string;
  source_assets?: string[];
  prompt_registry?: Record<string, PromptRegistryStageValue | undefined>;
  provider_ids?: {
    image_generation_job_refs?: string[];
    video_generation_job_refs?: string[];
  };
  signed_artifacts?: {
    final_mp4?: {
      expires_at?: string;
    };
    provenance_json?: {
      expires_at?: string;
    };
  };
  export_metadata?: {
    duration_seconds?: number;
    codec?: string;
    fps?: number;
    soundtrack?: string;
  };
};

function createClientRunId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `demo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readApiError(payload: unknown): ApiErrorResponse["error"] | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const maybeError = (payload as ApiErrorResponse).error;
  if (!maybeError || typeof maybeError !== "object") {
    return null;
  }

  return maybeError;
}

function isTerminalStatus(status: RunStatusPayload | null): boolean {
  if (!status) {
    return false;
  }

  return (
    TERMINAL_PHASES.has(status.phase) || TERMINAL_OUTCOMES.has(status.outcome)
  );
}

function humanizeReason(code: string): string {
  const messages: Record<string, string> = {
    invented_brand_critical_media:
      "Blocked because the request asks for invented brand-critical media rather than approved assets.",
    brand_critical_asset_required:
      "Each scene needs a predefined source image before video generation can continue.",
    brief_no_asset_match:
      "The script did not map cleanly to the predefined scene assets, so it needs clarification.",
    brief_ambiguous_visual_intent:
      "The brief is too ambiguous for a deterministic demo run.",
    provider_failed: "A provider step failed before the export could complete.",
    policy_blocked: "The request was blocked by the asset policy checks.",
    needs_clarification:
      "The request needs a more specific brief before it can continue.",
    rate_limited:
      "Too many requests were sent too quickly. Wait a moment and try again.",
    internal_error:
      "The demo backend hit an unexpected error while processing the run.",
    invalid_request: "The request payload did not match the expected shape.",
    not_found: "The requested run could not be found.",
  };

  return messages[code] ?? `Run ended with ${code.replaceAll("_", " ")}.`;
}

function providerRecoveryGuidance(
  status: RunStatusPayload | null,
): string | null {
  if (!status || status.outcome !== "provider_failed") {
    return null;
  }

  if (
    status.failureType === "provider_failed_status" &&
    status.providerReason?.toLowerCase().includes("usage guidelines")
  ) {
    const sceneLabel = status.sceneId ? ` for ${status.sceneId}` : "";
    return `Veo rejected the prompt${sceneLabel}. Simplify the scene into neutral visual direction, avoid direct-to-camera testimony or “best” style marketing claims, and keep it grounded in the selected asset.`;
  }

  return null;
}

function providerDetailLines(status: RunStatusPayload | null): string[] {
  if (!status || status.outcome !== "provider_failed") {
    return [];
  }

  const lines: string[] = [];
  if (status.sceneId) {
    lines.push(`Scene: ${status.sceneId}`);
  }
  if (status.providerReason) {
    lines.push(`Provider note: ${status.providerReason}`);
  } else if (status.errorMessage) {
    lines.push(`Error: ${status.errorMessage}`);
  }
  if (status.providerReasonCode) {
    lines.push(`Provider code: ${status.providerReasonCode}`);
  }

  const guidance = providerRecoveryGuidance(status);
  if (guidance) {
    lines.push(`Try: ${guidance}`);
  }

  return lines;
}

function describeStatus(status: RunStatusPayload | null): string {
  if (!status) {
    return "Paste a brief or use the sample preset to start a deterministic reviewer demo.";
  }

  if (status.outcome === "ok") {
    return "Completed successfully — final playback and provenance are ready below.";
  }

  if (
    status.outcome === "policy_blocked" ||
    status.outcome === "needs_clarification" ||
    status.outcome === "provider_failed"
  ) {
    return humanizeReason(status.errorCode ?? status.outcome);
  }

  const descriptions: Record<RunPhase, string> = {
    submitted: "Run accepted. Waiting for the first worker step.",
    normalizing: "Turning the plain-language brief into the normalized schema.",
    policy_validating:
      "Matching the normalized script to predefined scene assets.",
    generating_images: "Loading the selected scene images from local assets.",
    generating_video: "Generating scene video from predefined image inputs.",
    exporting: "Packaging audio, provenance, and the final MP4 artifact.",
    completed: "Run completed and artifacts are available.",
    failed: "Run failed before completion.",
  };

  return descriptions[status.phase];
}

function describeReadyState(fixtureMode: boolean): string {
  return fixtureMode
    ? "Paste a brief or use the sample preset to start a deterministic reviewer demo."
    : "Paste a brief or use the sample preset to start a live provider run.";
}

function formatJson(value: unknown, fallback: string): string {
  if (value === undefined) {
    return fallback;
  }

  return JSON.stringify(value, null, 2);
}

function getAssetView(assetId: string): ApprovedAssetRecord | null {
  return APPROVED_ASSET_BY_ID.get(assetId) ?? null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function isPromptRegistryEntry(value: unknown): value is PromptRegistryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return (
    "prompt_id" in value ||
    "version" in value ||
    "template_hash" in value ||
    "model" in value
  );
}

function asPromptRegistryEntries(
  value: PromptRegistryStageValue | undefined,
): PromptRegistryEntry[] {
  if (Array.isArray(value)) {
    return value.filter(isPromptRegistryEntry);
  }

  return isPromptRegistryEntry(value) ? [value] : [];
}

function statusTone(
  status: RunStatusPayload | null,
): "neutral" | "active" | "success" | "warning" | "danger" {
  if (!status) {
    return "neutral";
  }

  if (status.outcome === "ok") {
    return "success";
  }

  if (
    status.outcome === "policy_blocked" ||
    status.outcome === "provider_failed"
  ) {
    return "danger";
  }

  if (status.outcome === "needs_clarification") {
    return "warning";
  }

  return "active";
}

function toneClasses(tone: ReturnType<typeof statusTone>): string {
  switch (tone) {
    case "active":
      return "border-accent/30 bg-accent-soft text-accent";
    case "success":
      return "border-success/30 bg-success/15 text-success";
    case "warning":
      return "border-warning/30 bg-warning/15 text-warning";
    case "danger":
      return "border-danger/30 bg-danger/15 text-danger";
    default:
      return "border-border bg-surface-elevated text-muted-strong";
  }
}

export function PublicDemoPage() {
  const initialFixtureMode = defaultFixtureModeForEnvironment(process.env.NODE_ENV);
  const [fixtureMode, setFixtureMode] = useState(initialFixtureMode);
  const [brief, setBrief] = useState(() =>
    sampleBriefForMode(initialFixtureMode),
  );
  const [isStarting, setIsStarting] = useState(false);
  const [pollingRunId, setPollingRunId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatusPayload | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [provenance, setProvenance] = useState<ProvenancePayload | null>(null);
  const [provenanceError, setProvenanceError] = useState<string | null>(null);
  const [isLoadingProvenance, setIsLoadingProvenance] = useState(false);

  const selectedAssets = useMemo(() => {
    return (runStatus?.selectedAssetIds ?? []).map((assetId) => ({
      assetId,
      asset: getAssetView(assetId),
    }));
  }, [runStatus?.selectedAssetIds]);

  const normalizedJson = useMemo(() => {
    return formatJson(
      runStatus?.normalizedBrief,
      "Normalized brief JSON will appear here once the normalize step succeeds.",
    );
  }, [runStatus?.normalizedBrief]);

  useEffect(() => {
    setBrief((currentBrief) => {
      if (
        currentBrief !== FIXTURE_SAMPLE_BRIEF &&
        currentBrief !== LIVE_SAMPLE_BRIEF
      ) {
        return currentBrief;
      }

      return sampleBriefForMode(fixtureMode);
    });
  }, [fixtureMode]);

  useEffect(() => {
    if (!pollingRunId) {
      return;
    }

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const response = await fetch(`/api/v1/runs/${pollingRunId}`, {
          method: "GET",
          cache: "no-store",
        });
        const payload = (await response.json()) as
          | RunStatusPayload
          | ApiErrorResponse;

        if (!response.ok) {
          const error = readApiError(payload);
          throw new Error(error?.message ?? "Failed to load run status.");
        }

        if (cancelled) {
          return;
        }

        const nextStatus = payload as RunStatusPayload;
        setRunStatus(nextStatus);

        if (isTerminalStatus(nextStatus)) {
          setPollingRunId(null);
        } else {
          timeoutId = setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        setRequestError(
          error instanceof Error ? error.message : "Failed to load run status.",
        );
        setPollingRunId(null);
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [pollingRunId]);

  const provenanceUrl = runStatus?.provenanceUrl;

  useEffect(() => {
    if (!provenanceUrl) {
      setProvenance(null);
      setProvenanceError(null);
      setIsLoadingProvenance(false);
      return;
    }

    const resolvedProvenanceUrl = provenanceUrl;

    let cancelled = false;

    const loadProvenance = async () => {
      setIsLoadingProvenance(true);
      setProvenanceError(null);

      try {
        const response = await fetch(resolvedProvenanceUrl, {
          method: "GET",
          cache: "no-store",
        });
        const payload = (await response.json()) as
          | ProvenancePayload
          | ApiErrorResponse;

        if (!response.ok) {
          const error = readApiError(payload);
          throw new Error(error?.message ?? "Failed to load provenance.");
        }

        if (!cancelled) {
          setProvenance(payload as ProvenancePayload);
        }
      } catch (error) {
        if (!cancelled) {
          setProvenanceError(
            error instanceof Error
              ? error.message
              : "Failed to load provenance.",
          );
        }
      } finally {
        if (!cancelled) {
          setIsLoadingProvenance(false);
        }
      }
    };

    void loadProvenance();

    return () => {
      cancelled = true;
    };
  }, [provenanceUrl]);

  const currentPhaseIndex = runStatus
    ? PHASE_STEPS.findIndex((s) => s.phase === runStatus.phase)
    : -1;

  const messageTone = statusTone(runStatus);
  const statusMessage =
    requestError ?? (runStatus ? describeStatus(runStatus) : describeReadyState(fixtureMode));
  const statusErrorMessage =
    requestError ??
    (runStatus?.outcome === "policy_blocked" ||
    runStatus?.outcome === "needs_clarification" ||
    runStatus?.outcome === "provider_failed"
      ? humanizeReason(runStatus.errorCode ?? runStatus.outcome)
      : null);

  const providerErrorDetails = providerDetailLines(runStatus);

  const hasStartedRun = isStarting || runStatus !== null;

  const handleReset = () => {
    setRunStatus(null);
    setPollingRunId(null);
    setRequestError(null);
    setProvenance(null);
    setProvenanceError(null);
    setIsStarting(false);
  };

  const handleGenerate = async () => {
    const trimmedBrief = brief.trim();
    if (!trimmedBrief) {
      setRequestError("Enter a short creative brief before starting the demo.");
      return;
    }

    setIsStarting(true);
    setRequestError(null);
    setProvenance(null);
    setProvenanceError(null);

    try {
      const response = await fetch("/api/v1/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": createClientRunId(),
        },
        body: JSON.stringify({
          brief: trimmedBrief,
          fixtureMode,
        }),
      });

      const payload = (await response.json()) as
        | StartRunResponse
        | ApiErrorResponse;
      if (!response.ok) {
        const error = readApiError(payload);
        throw new Error(error?.message ?? "Failed to start the run.");
      }

      const nextRunId = (payload as StartRunResponse).runId;
      setRunStatus({
        runId: nextRunId,
        phase: "submitted",
        outcome: "none",
      });
      setPollingRunId(nextRunId);
    } catch (error) {
      setRunStatus(null);
      setPollingRunId(null);
      setRequestError(
        error instanceof Error ? error.message : "Failed to start the run.",
      );
    } finally {
      setIsStarting(false);
    }
  };

  const provenancePrompts = provenance?.prompt_registry ?? {};
  const sourceAssets = provenance?.source_assets ?? [];
  const imageProviderRefs = asStringArray(
    provenance?.provider_ids?.image_generation_job_refs,
  );
  const videoProviderRefs = asStringArray(
    provenance?.provider_ids?.video_generation_job_refs,
  );

  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <section className="panel overflow-hidden group">
          <div className="flex flex-col gap-6 px-6 py-8 lg:flex-row lg:items-end lg:justify-between lg:px-10 lg:py-10">
            <div className="max-w-3xl space-y-8 relative z-10">
              <div className="inline-flex items-center gap-2">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-accent"></span>
                </span>
                <p className="inline-flex text-xs font-bold uppercase tracking-[0.25em] text-accent shadow-sm bg-accent/10 px-3 py-1 rounded-full border border-accent/20 backdrop-blur-md">
                  Public creative pipeline demo
                </p>
              </div>
              <div className="space-y-5">
                <h1 className="max-w-3xl text-4xl font-extrabold tracking-tight text-balance sm:text-5xl lg:text-7xl bg-clip-text text-transparent bg-linear-to-r from-accent via-purple-500 to-indigo-400 drop-shadow-sm animate-in fade-in slide-in-from-bottom-8 duration-700">
                  Brief in, approved lineage out.
                </h1>
                <p className="max-w-2xl text-base leading-relaxed text-muted-strong sm:text-lg lg:text-xl font-medium animate-in fade-in slide-in-from-bottom-8 duration-700 delay-150">
                  This single-page reviewer demo submits a brief, watches the
                  SQLite-backed pipeline progress, surfaces normalized JSON and
                  approved assets, then shows the signed video and provenance
                  artifacts.
                </p>
              </div>
            </div>

            <div
              className={`inline-flex max-w-xl items-start gap-4 rounded-2xl border px-5 py-4 text-sm leading-6 shadow-sm transition-colors duration-300 ${toneClasses(messageTone)}`}
            >
              <span className="mt-1 h-3 w-3 shrink-0 rounded-full bg-current shadow-[0_0_12px_currentColor] animate-pulse" />
              <div className="space-y-1">
                <p className="font-bold tracking-wide">
                  {runStatus
                    ? `${runStatus.phase.replaceAll("_", " ")} · ${runStatus.outcome.replaceAll("_", " ")}`
                    : fixtureMode
                      ? "Ready for a deterministic run"
                      : "Ready for a live run"}
                </p>
                <p className="opacity-90">{statusMessage}</p>
              </div>
            </div>
          </div>
        </section>

        {!hasStartedRun ? (
          <div className="grid gap-8 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] animate-in fade-in slide-in-from-bottom-4 duration-500">
            <section className="space-y-8">
              <div className="panel px-6 py-8 lg:px-10">
                <div className="flex flex-col gap-8">
                  <div className="space-y-2">
                    <h2 className="text-2xl font-bold tracking-tight bg-clip-text text-transparent bg-linear-to-r from-foreground to-muted">
                      Video script
                    </h2>
                    <p className="text-sm leading-6 text-muted">
                      Start from your own script or load the default social-ad
                      script and let GPT-5.4-mini turn it into structured scenes.
                    </p>
                  </div>

                  <label className="space-y-3 block group">
                    <span className="text-sm font-semibold tracking-wide text-muted-strong group-focus-within:text-accent transition-colors duration-300">
                      Script input
                    </span>
                    <div className="relative transform transition-all duration-300 group-focus-within:scale-[1.01] group-focus-within:-translate-y-1">
                      <div className="absolute -inset-0.5 rounded-[1.25rem] bg-linear-to-r from-accent to-indigo-500 opacity-0 blur-md transition-opacity duration-500 group-focus-within:opacity-20" />
                      <textarea
                        data-testid="brief-input"
                        value={brief}
                        onChange={(event) => setBrief(event.target.value)}
                        placeholder="Paste a short ad script or hook for the video."
                        className="relative min-h-52 w-full rounded-2xl border border-border/80 bg-background/40 px-5 py-4 text-base leading-7 text-foreground shadow-inner backdrop-blur-xl outline-none transition-all duration-300 focus:border-accent/80 focus:bg-background/80 focus:ring-4 focus:ring-accent/10 focus:shadow-[0_8px_30px_rgb(0,0,0,0.04)] resize-y custom-scrollbar"
                      />
                    </div>
                  </label>

                  <div className="flex flex-col gap-5 rounded-2xl border border-border/50 bg-background/20 p-5 backdrop-blur-md sm:flex-row sm:items-center sm:justify-between shadow-xs transition-shadow hover:shadow-md">
                    <label className="flex items-center gap-3 text-sm font-medium leading-6 text-muted-strong cursor-pointer group">
                      <div className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-300 ease-in-out">
                        <input
                          data-testid="fixture-mode-toggle"
                          type="checkbox"
                          checked={fixtureMode}
                          onChange={(event) => setFixtureMode(event.target.checked)}
                          className="peer sr-only"
                        />
                        <div className="h-full w-full rounded-full bg-muted/30 border border-border transition-all peer-checked:bg-accent peer-checked:border-accent"></div>
                        <span
                          className={`absolute left-0.5 top-0.5 h-5 w-5 transform rounded-full bg-white shadow-xs transition-transform duration-300 ease-in-out ${
                            fixtureMode ? "translate-x-5" : "translate-x-0"
                          }`}
                        />
                      </div>
                      <span className="transition-colors group-hover:text-foreground">Use demo fixture mode</span>
                    </label>

                    <div className="flex flex-wrap items-center gap-4">
                      <button
                        data-testid="sample-brief-button"
                        type="button"
                        onClick={() => {
                          setBrief(sampleBriefForMode(fixtureMode));
                          setRequestError(null);
                        }}
                        className="inline-flex items-center justify-center rounded-xl border border-border/50 bg-surface/50 px-5 py-2.5 text-sm font-semibold text-muted-strong backdrop-blur-sm transition-all duration-300 hover:border-accent hover:text-accent hover:shadow-[0_4px_20px_rgba(79,70,229,0.15)] hover:-translate-y-0.5 hover:scale-[1.02] active:scale-[0.98] active:translate-y-0"
                      >
                        Load sample brief
                      </button>

                      <button
                        data-testid="generate-button"
                        type="button"
                        onClick={() => void handleGenerate()}
                        disabled={isStarting}
                        className="group relative inline-flex items-center justify-center rounded-xl bg-linear-to-r from-accent to-indigo-500 px-6 py-2.5 text-sm font-bold text-white shadow-[0_4px_14px_0_rgba(99,102,241,0.39)] transition-all duration-300 hover:shadow-[0_6px_20px_rgba(99,102,241,0.5)] hover:-translate-y-0.5 hover:scale-[1.02] active:scale-[0.98] active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 disabled:transform-none disabled:shadow-none overflow-hidden"
                      >
                        <div className="absolute inset-0 bg-white/20 translate-y-full transition-transform duration-300 group-hover:translate-y-0 blur-sm pointer-events-none"></div>
                        {isStarting ? (
                          <span className="relative flex items-center gap-2">
                            <svg
                              className="animate-spin -ml-1 mr-2 h-4 w-4 text-white"
                              xmlns="http://www.w3.org/2000/svg"
                              fill="none"
                              viewBox="0 0 24 24"
                            >
                              <circle
                                className="opacity-25"
                                cx="12"
                                cy="12"
                                r="10"
                                stroke="currentColor"
                                strokeWidth="4"
                              ></circle>
                              <path
                                className="opacity-75"
                                fill="currentColor"
                                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                              ></path>
                            </svg>
                            Submitting…
                          </span>
                        ) : (
                          <span className="relative">Generate demo</span>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {statusErrorMessage ? (
                <div className="rounded-3xl border border-danger/30 bg-danger/12 px-4 py-3 text-sm leading-6 text-danger shadow-sm">
                  <div className="space-y-2">
                    <p>{statusErrorMessage}</p>
                    {providerErrorDetails.length > 0 ? (
                      <div className="space-y-1 text-danger/90">
                        {providerErrorDetails.map((line) => (
                          <p key={line}>{line}</p>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </section>
            
            <aside className="hidden xl:block">
              <div className="h-full w-full rounded-2xl border border-dashed border-border/50 bg-background/20 flex items-center justify-center p-8 opacity-50">
                <div className="text-center space-y-4">
                  <svg className="w-12 h-12 mx-auto text-muted-strong opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <p className="text-sm font-medium text-muted uppercase tracking-widest">Awaiting Generator</p>
                  <p className="max-w-[200px] text-xs leading-5 text-muted">Submit your brief to initiate the video pipeline. Progress and artifacts will appear here.</p>
                </div>
              </div>
            </aside>
          </div>
        ) : (
          <div className="grid gap-8 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] animate-in fade-in slide-in-from-bottom-4 duration-500">
            <section className="space-y-8">
              {statusErrorMessage ? (
                <div className="rounded-3xl border border-danger/30 bg-danger/12 px-4 py-3 text-sm leading-6 text-danger shadow-sm">
                  <div className="space-y-2">
                    <p>{statusErrorMessage}</p>
                    {providerErrorDetails.length > 0 ? (
                      <div className="space-y-1 text-danger/90">
                        {providerErrorDetails.map((line) => (
                          <p key={line}>{line}</p>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div className="panel px-6 py-8 lg:px-10">
                <div className="flex flex-col gap-8">
                  <div className="grid gap-6 lg:grid-cols-2">
                  <div className="rounded-3xl border border-border bg-surface-elevated p-5">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted">
                        Normalized JSON
                      </h3>
                      {runStatus?.runId ? (
                        <span className="rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-strong">
                          {runStatus.runId}
                        </span>
                      ) : null}
                    </div>
                    <pre
                      data-testid="normalized-json"
                      className="max-h-[30rem] overflow-auto rounded-2xl bg-background/70 p-4 font-mono text-xs leading-6 text-muted-strong"
                    >
                      {normalizedJson}
                    </pre>
                  </div>

                  <div
                    data-testid="selected-assets"
                    className="rounded-3xl border border-border bg-surface-elevated p-5"
                  >
                    <div className="mb-4 space-y-1">
                      <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted">
                        Selected assets
                      </h3>
                      <p className="text-sm leading-6 text-muted">
                        The predefined scene assets selected for the current run
                        appear here.
                      </p>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      {selectedAssets.length > 0 ? (
                        selectedAssets.map(({ assetId, asset }) => (
                          <article
                            key={assetId}
                            className="overflow-hidden rounded-2xl border border-border bg-surface"
                          >
                            {asset ? (
                              <img
                                src={`/assets/approved/${asset.filename}`}
                                alt=""
                                className="h-32 w-full border-b border-border bg-background object-contain p-4"
                              />
                            ) : (
                              <div className="flex h-32 items-center justify-center border-b border-border bg-background text-sm text-muted">
                                Unknown asset preview
                              </div>
                            )}
                            <div className="space-y-2 p-4">
                              <p className="font-medium text-foreground">
                                {assetId}
                              </p>
                              <p className="text-sm text-muted">
                                {asset?.filename ??
                                  "Manifest details unavailable."}
                              </p>
                              {asset ? (
                                <p className="text-xs uppercase tracking-[0.16em] text-muted">
                                  {asset.tags.join(" · ")}
                                </p>
                              ) : null}
                            </div>
                          </article>
                        ))
                      ) : (
                        <div className="rounded-2xl border border-dashed border-border px-4 py-8 text-sm leading-6 text-muted sm:col-span-2">
                          Selected scene assets appear after the asset-selection
                          step succeeds.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="panel px-6 py-6 lg:px-8">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="space-y-1">
                  <h2 className="text-xl font-semibold tracking-tight">
                    Final playback
                  </h2>
                  <p className="text-sm leading-6 text-muted">
                    Signed artifacts are served by the existing Task 8 artifact
                    routes.
                  </p>
                </div>
                {runStatus?.resultUrl ? (
                  <a
                    href={runStatus.resultUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm font-medium text-accent underline-offset-4 hover:underline"
                  >
                    Open MP4
                  </a>
                ) : null}
              </div>

              <div className="rounded-3xl border border-border bg-background/50 p-2 shadow-inner">
                <div className="flex justify-center rounded-2xl overflow-hidden relative group">
                  <div className="absolute inset-0 bg-linear-to-tr from-accent/20 to-purple-500/20 opacity-0 group-hover:opacity-100 transition duration-500 pointer-events-none"></div>
                  <video
                    data-testid="video-player"
                    controls
                    preload="metadata"
                    src={runStatus?.resultUrl}
                    className={`block max-h-[75vh] w-auto max-w-full bg-slate-950 shadow-2xl ${runStatus?.resultUrl ? "" : "hidden"}`}
                  />
                </div>
                {!runStatus?.resultUrl ? (
                  <div className="mx-auto flex aspect-[4/9] w-full max-w-sm flex-col items-center justify-center rounded-2xl border border-dashed border-border/70 bg-surface/30 px-6 text-center text-sm leading-6 text-muted-strong shadow-sm my-2">
                    <svg
                      className="w-12 h-12 text-muted mb-4 opacity-50"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="1"
                        d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
                      />
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="1"
                        d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                    Final video playback appears here after the export step
                    completes.
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          <aside className="space-y-8 relative z-10">
            <div className="panel px-6 py-8 lg:px-10">
              <div className="mb-6 flex flex-wrap justify-between items-start gap-4">
                <div className="space-y-1">
                  <h2 className="text-xl font-bold tracking-tight">Run progress</h2>
                  <p className="text-sm leading-6 text-muted">
                    Each stage becomes visibly complete, active, or stopped as the run advances.
                  </p>
                </div>
                {isTerminalStatus(runStatus) || requestError ? (
                  <button
                    onClick={handleReset}
                    className="px-5 py-2.5 rounded-xl text-xs font-bold uppercase tracking-wider bg-accent/10 text-accent border border-accent/20 hover:bg-accent hover:text-white transition-all duration-300 shadow-[0_0_15px_rgba(79,70,229,0.15)] hover:shadow-[0_0_25px_rgba(79,70,229,0.35)] cursor-pointer hover:scale-[1.05] active:scale-[0.95]"
                  >
                    New Run
                  </button>
                ) : null}
              </div>

              <div className="relative">
                {/* Dynamic Connecting Line */}
                <div className="absolute left-6 top-6 bottom-6 w-[2px] bg-border/40 overflow-hidden z-0">
                  <div 
                    className="absolute top-0 left-0 w-full bg-linear-to-b from-accent to-purple-500 transition-all duration-1000 ease-in-out"
                    style={{ height: `${Math.max(0, currentPhaseIndex) * (100 / (PHASE_STEPS.length - 1))}%` }}
                  ></div>
                </div>
                
                <ol data-testid="status-timeline" className="space-y-6 relative z-10 w-full">
                  {PHASE_STEPS.map((step, index) => {
                    const isCompleted = currentPhaseIndex > index || runStatus?.outcome === "ok";
                    const isCurrent = currentPhaseIndex === index && !isTerminalStatus(runStatus);
                    const isFailed = runStatus?.phase === "failed" && index === Math.max(currentPhaseIndex, 0);

                    return (
                      <li
                        key={step.phase}
                        className={`relative flex items-center gap-6 w-full group transition-all duration-500 ease-out ${
                          !isCompleted && !isCurrent && !isFailed ? "opacity-60 grayscale hover:grayscale-0 hover:opacity-100" : ""
                        }`}
                      >
                        <span
                          className={`relative z-20 flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-2 text-sm font-bold shadow-sm transition-all duration-500 ${
                            isCompleted
                              ? "border-success bg-success text-white shadow-[0_0_15px_rgba(16,185,129,0.4)]"
                              : isCurrent
                                ? "border-accent bg-accent text-white shadow-[0_0_20px_rgba(79,70,229,0.6)] scale-[1.05]"
                                : isFailed
                                  ? "border-danger bg-danger text-white shadow-[0_0_15px_rgba(239,68,68,0.4)]"
                                  : "border-border/60 bg-surface-elevated text-muted"
                          }`}
                        >
                          {isCurrent && (
                            <span className="absolute inset-0 rounded-full border-2 border-accent animate-ping opacity-75"></span>
                          )}
                          {isCompleted ? (
                            <svg className="w-6 h-6 animate-in zoom-in duration-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" />
                            </svg>
                          ) : (
                            <span className={isCurrent ? "animate-pulse" : ""}>{index + 1}</span>
                          )}
                        </span>
                        
                        <div className={`p-4 rounded-2xl flex-1 border transition-all duration-500 bg-background/30 backdrop-blur-md ${
                          isCompleted
                            ? "border-success/15 shadow-[0_4px_20px_rgba(16,185,129,0.05)]"
                            : isCurrent
                              ? "border-accent/30 shadow-[0_4px_30px_rgba(79,70,229,0.1)] scale-[1.01]"
                              : isFailed
                                ? "border-danger/30 shadow-[0_4px_20px_rgba(239,68,68,0.05)]"
                                : "border-border/40 group-hover:border-border/80"
                        }`}>
                          <div className="flex flex-wrap items-center gap-2 mb-1.5">
                            <p className={`font-semibold ${isCurrent ? "text-accent drop-shadow-xs" : "text-foreground"}`}>
                              {step.label}
                            </p>
                            {isCurrent ? (
                              <span className="rounded-full border border-accent/40 bg-accent/20 px-2.5 py-0.5 text-[10px] uppercase font-bold text-accent tracking-widest animate-pulse shadow-[0_0_10px_rgba(79,70,229,0.2)]">
                                Live
                              </span>
                            ) : null}
                            {isCompleted ? (
                              <span className="rounded-full border border-success/30 bg-success/15 px-2.5 py-0.5 text-[10px] uppercase font-bold text-success tracking-widest">
                                Done
                              </span>
                            ) : null}
                            {isFailed ? (
                              <span className="rounded-full border border-danger/40 bg-danger/20 px-2.5 py-0.5 text-[10px] uppercase font-bold text-danger tracking-widest">
                                Stopped
                              </span>
                            ) : null}
                          </div>
                          <p className="text-sm leading-6 text-muted font-medium">
                            {step.detail}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>
            </div>

            <div
              data-testid="provenance-panel"
              className="panel px-6 py-8 lg:px-10"
            >
              <div className="mb-6 space-y-1">
                <h2 className="text-xl font-bold tracking-tight">Provenance</h2>
                <p className="text-sm leading-6 text-muted">
                  Source asset IDs, prompt metadata, and provider references
                  stay visible for reviewer trust.
                </p>
              </div>

              <div className="space-y-6 text-sm leading-6">
                <div className="rounded-2xl border border-border bg-background/40 backdrop-blur-md p-5 shadow-sm">
                  <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted mb-3 flex items-center gap-2">
                    <svg
                      className="w-4 h-4 text-accent"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                      />
                    </svg>
                    Source asset IDs
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {sourceAssets.length > 0 ? (
                      sourceAssets.map((assetId) => (
                        <span
                          key={assetId}
                          className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-muted-strong shadow-sm"
                        >
                          {assetId}
                        </span>
                      ))
                    ) : (
                      <p className="text-muted italic">
                        {isLoadingProvenance
                          ? "Loading provenance artifact…"
                          : "Source asset lineage will appear once the signed provenance artifact is available."}
                      </p>
                    )}
                  </div>
                </div>

                <div className="rounded-2xl border border-border bg-background/40 backdrop-blur-md p-5 shadow-sm">
                  <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted mb-4 flex items-center gap-2">
                    <svg
                      className="w-4 h-4 text-accent"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                      />
                    </svg>
                    Prompt + model registry
                  </p>
                  <div className="space-y-4">
                    {Object.entries(provenancePrompts).length > 0 ? (
                      Object.entries(provenancePrompts).map(
                        ([stageName, entry]) => {
                          const promptEntries = asPromptRegistryEntries(entry);

                          return (
                            <div
                              key={stageName}
                              className="rounded-xl border border-border bg-surface p-4 shadow-sm"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                                <p className="font-semibold text-sm capitalize text-foreground border-b-2 border-accent/30 pb-0.5">
                                  {stageName.replaceAll("_", " ")}
                                </p>
                              </div>

                              {promptEntries.length > 0 ? (
                                <div className="space-y-3">
                                  {promptEntries.map((promptEntry, index) => (
                                    <div
                                      key={`${stageName}-${promptEntry.prompt_id ?? index}`}
                                      className="rounded-lg bg-background/60 p-3 text-[13px] border border-border/50"
                                    >
                                      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                                        {promptEntries.length > 1 ? (
                                          <p className="text-[10px] font-bold uppercase tracking-widest text-muted">
                                            Prompt {index + 1}
                                          </p>
                                        ) : (
                                          <span />
                                        )}
                                        {promptEntry.model ? (
                                          <span className="rounded-md bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent">
                                            {promptEntry.model}
                                          </span>
                                        ) : null}
                                      </div>
                                      <p className="font-mono text-xs text-muted-strong break-all bg-surface-elevated p-2 rounded">
                                        {promptEntry.prompt_id ??
                                          "Prompt metadata unavailable."}
                                      </p>
                                      <p className="text-[11px] text-muted mt-2 flex items-center gap-2">
                                        <span className="px-1.5 py-0.5 rounded bg-surface border border-border">
                                          v{promptEntry.version ?? "?"}
                                        </span>
                                        <span className="opacity-50">•</span>
                                        <span className="font-mono truncate">
                                          {promptEntry.template_hash ??
                                            "no-template-hash"}
                                        </span>
                                      </p>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <p className="text-muted italic text-xs">
                                  Prompt metadata unavailable.
                                </p>
                              )}
                            </div>
                          );
                        },
                      )
                    ) : (
                      <p className="text-muted italic">
                        Prompt registry metadata will load from the provenance
                        artifact after export.
                      </p>
                    )}
                  </div>
                </div>

                <div className="rounded-2xl border border-border bg-background/40 backdrop-blur-md p-5 shadow-sm">
                  <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted mb-3 flex items-center gap-2">
                    <svg
                      className="w-4 h-4 text-accent"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                      />
                    </svg>
                    Provider references
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-xl border border-border bg-surface p-4 shadow-sm">
                      <p className="font-semibold text-[13px] text-foreground">
                        Image generation
                      </p>
                      <p className="mt-1 text-xs text-muted font-mono break-all">
                        {imageProviderRefs.length > 0
                          ? imageProviderRefs.join(", ")
                          : "No recorded jobs"}
                      </p>
                    </div>
                    <div className="rounded-xl border border-border bg-surface p-4 shadow-sm">
                      <p className="font-semibold text-[13px] text-foreground">
                        Video generation
                      </p>
                      <p className="mt-1 text-xs text-muted font-mono break-all">
                        {videoProviderRefs.length > 0
                          ? videoProviderRefs.join(", ")
                          : "No recorded jobs"}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-border bg-background/40 backdrop-blur-md p-5 shadow-sm">
                  <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted mb-3 flex items-center gap-2">
                    <svg
                      className="w-4 h-4 text-accent"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                      />
                    </svg>
                    Artifact metadata
                  </p>
                  <div className="space-y-3 text-sm">
                    <div className="flex justify-between items-center py-1.5 border-b border-border/50">
                      <span className="text-muted">Final MP4 expires</span>
                      <span className="font-mono text-xs">
                        {provenance?.signed_artifacts?.final_mp4?.expires_at ??
                          "Pending"}
                      </span>
                    </div>
                    <div className="flex justify-between items-center py-1.5 border-b border-border/50">
                      <span className="text-muted">Duration / Codec</span>
                      <span className="font-mono text-xs">
                        {provenance?.export_metadata?.duration_seconds ?? "—"}s
                        · {provenance?.export_metadata?.codec ?? "—"}
                      </span>
                    </div>
                    <div className="flex justify-between items-center py-1.5">
                      <span className="text-muted">FPS / Soundtrack</span>
                      <span className="font-mono text-xs">
                        {provenance?.export_metadata?.fps ?? "—"} ·{" "}
                        {provenance?.export_metadata?.soundtrack ?? "—"}
                      </span>
                    </div>
                  </div>
                </div>

                {provenanceError ? (
                  <div className="rounded-3xl border border-warning/30 bg-warning/12 px-4 py-3 text-warning">
                    {provenanceError}
                  </div>
                ) : null}
              </div>
            </div>
          </aside>
        </div>
        )}
      </div>
    </main>
  );
}
