"use client";

import { APPROVED_ASSET_BY_ID, type ApprovedAssetRecord } from "@shared/domain/approved-assets";
import type { RunOutcome, RunPhase } from "@shared/domain/contracts";
import { useEffect, useMemo, useState } from "react";

const SAMPLE_BRIEF = [
  "Create a 15-second Deal Pump social ad that opens on the approved wordmark over the studio backdrop,",
  "cuts to the approved can packshot with energetic motion, and closes with a strong CTA.",
  "Keep it punchy, premium, and obviously derived from approved brand assets.",
].join(" ");

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
    label: "Policy validation",
    detail: "Approved asset coverage and brand-safety checks are applied.",
  },
  {
    phase: "generating_images",
    label: "Generating stills",
    detail: "Asset-derived scene stills are prepared for animation.",
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

const TERMINAL_OUTCOMES = new Set<RunOutcome>(["ok", "needs_clarification", "policy_blocked", "provider_failed"]);
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

type ProvenancePayload = {
  run_id?: string;
  source_assets?: string[];
  prompt_registry?: Record<string, PromptRegistryEntry | undefined>;
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

  return TERMINAL_PHASES.has(status.phase) || TERMINAL_OUTCOMES.has(status.outcome);
}

function humanizeReason(code: string): string {
  const messages: Record<string, string> = {
    invented_brand_critical_media: "Blocked because the request asks for invented brand-critical media rather than approved assets.",
    brand_critical_asset_required: "Brand-critical scenes need at least one approved source asset.",
    brief_no_asset_match: "The brief did not map cleanly to any approved assets, so it needs clarification.",
    brief_ambiguous_visual_intent: "The brief is too ambiguous for a deterministic demo run.",
    provider_failed: "A provider step failed before the export could complete.",
    policy_blocked: "The request was blocked by the asset policy checks.",
    needs_clarification: "The request needs a more specific brief before it can continue.",
    rate_limited: "Too many requests were sent too quickly. Wait a moment and try again.",
    internal_error: "The demo backend hit an unexpected error while processing the run.",
    invalid_request: "The request payload did not match the expected shape.",
    not_found: "The requested run could not be found.",
  };

  return messages[code] ?? `Run ended with ${code.replaceAll("_", " ")}.`;
}

function describeStatus(status: RunStatusPayload | null): string {
  if (!status) {
    return "Paste a brief or use the sample preset to start a deterministic reviewer demo.";
  }

  if (status.outcome === "ok") {
    return "Completed successfully — final playback and provenance are ready below.";
  }

  if (status.outcome === "policy_blocked" || status.outcome === "needs_clarification" || status.outcome === "provider_failed") {
    return humanizeReason(status.errorCode ?? status.outcome);
  }

  const descriptions: Record<RunPhase, string> = {
    submitted: "Run accepted. Waiting for the first worker step.",
    normalizing: "Turning the plain-language brief into the normalized schema.",
    policy_validating: "Checking the brief against approved-asset and policy rules.",
    generating_images: "Preparing asset-derived stills for the final motion sequence.",
    generating_video: "Generating scene video from approved asset-derived inputs.",
    exporting: "Packaging subtitles, provenance, and the final MP4 artifact.",
    completed: "Run completed and artifacts are available.",
    failed: "Run failed before completion.",
  };

  return descriptions[status.phase];
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

function statusTone(status: RunStatusPayload | null): "neutral" | "active" | "success" | "warning" | "danger" {
  if (!status) {
    return "neutral";
  }

  if (status.outcome === "ok") {
    return "success";
  }

  if (status.outcome === "policy_blocked" || status.outcome === "provider_failed") {
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
  const [brief, setBrief] = useState(SAMPLE_BRIEF);
  const [fixtureMode, setFixtureMode] = useState(true);
  const [isStarting, setIsStarting] = useState(false);
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
    return formatJson(runStatus?.normalizedBrief, "Normalized brief JSON will appear here once the normalize step succeeds.");
  }, [runStatus?.normalizedBrief]);

  useEffect(() => {
    if (!runStatus?.runId || isTerminalStatus(runStatus)) {
      return;
    }

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const response = await fetch(`/api/v1/runs/${runStatus.runId}`, {
          method: "GET",
          cache: "no-store",
        });
        const payload = (await response.json()) as RunStatusPayload | ApiErrorResponse;

        if (!response.ok) {
          const error = readApiError(payload);
          throw new Error(error?.message ?? "Failed to load run status.");
        }

        if (cancelled) {
          return;
        }

        const nextStatus = payload as RunStatusPayload;
        setRunStatus(nextStatus);

        if (!isTerminalStatus(nextStatus)) {
          timeoutId = setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        setRequestError(error instanceof Error ? error.message : "Failed to load run status.");
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [runStatus]);

  useEffect(() => {
    if (!runStatus?.provenanceUrl) {
      setProvenance(null);
      setProvenanceError(null);
      setIsLoadingProvenance(false);
      return;
    }

    let cancelled = false;

    const loadProvenance = async () => {
      setIsLoadingProvenance(true);
      setProvenanceError(null);

      try {
        const response = await fetch(runStatus.provenanceUrl, {
          method: "GET",
          cache: "no-store",
        });
        const payload = (await response.json()) as ProvenancePayload | ApiErrorResponse;

        if (!response.ok) {
          const error = readApiError(payload);
          throw new Error(error?.message ?? "Failed to load provenance.");
        }

        if (!cancelled) {
          setProvenance(payload as ProvenancePayload);
        }
      } catch (error) {
        if (!cancelled) {
          setProvenanceError(error instanceof Error ? error.message : "Failed to load provenance.");
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
  }, [runStatus?.provenanceUrl]);

  const currentPhaseIndex = runStatus ? PHASE_STEPS.findIndex((step) => step.phase === runStatus.phase) : -1;
  const messageTone = statusTone(runStatus);
  const statusMessage = requestError ?? describeStatus(runStatus);
  const statusErrorMessage = requestError ?? ((runStatus?.outcome === "policy_blocked" || runStatus?.outcome === "needs_clarification" || runStatus?.outcome === "provider_failed")
    ? humanizeReason(runStatus.errorCode ?? runStatus.outcome)
    : null);

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

      const payload = (await response.json()) as StartRunResponse | ApiErrorResponse;
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
    } catch (error) {
      setRunStatus(null);
      setRequestError(error instanceof Error ? error.message : "Failed to start the run.");
    } finally {
      setIsStarting(false);
    }
  };

  const provenancePrompts = provenance?.prompt_registry ?? {};
  const sourceAssets = provenance?.source_assets ?? [];
  const imageProviderRefs = asStringArray(provenance?.provider_ids?.image_generation_job_refs);
  const videoProviderRefs = asStringArray(provenance?.provider_ids?.video_generation_job_refs);

  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <section className="panel overflow-hidden">
          <div className="flex flex-col gap-6 px-6 py-6 lg:flex-row lg:items-end lg:justify-between lg:px-8 lg:py-8">
            <div className="max-w-3xl space-y-4">
              <p className="text-sm font-medium uppercase tracking-[0.24em] text-accent">
                Public creative pipeline demo
              </p>
              <div className="space-y-3">
                <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
                  Brief in, approved lineage out, playback ready.
                </h1>
                <p className="max-w-2xl text-base leading-7 text-muted-strong sm:text-lg">
                  This single-page reviewer demo submits a brief, watches the SQLite-backed pipeline progress,
                  surfaces normalized JSON and approved assets, then shows the signed video and provenance artifacts.
                </p>
              </div>
            </div>

            <div className={`inline-flex max-w-xl items-start gap-3 rounded-2xl border px-4 py-3 text-sm leading-6 ${toneClasses(messageTone)}`}>
              <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-current" />
              <div className="space-y-1">
                <p className="font-semibold">
                  {runStatus ? `${runStatus.phase.replaceAll("_", " ")} · ${runStatus.outcome.replaceAll("_", " ")}` : "Ready for a deterministic run"}
                </p>
                <p>{statusMessage}</p>
              </div>
            </div>
          </div>
        </section>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          <section className="space-y-6">
            <div className="panel px-6 py-6 lg:px-8">
              <div className="flex flex-col gap-6">
                <div className="space-y-2">
                  <h2 className="text-xl font-semibold tracking-tight">Creative brief</h2>
                  <p className="text-sm leading-6 text-muted">
                    Keep fixture mode on for a deterministic reviewer flow that exercises the existing Task 8 routes.
                  </p>
                </div>

                <label className="space-y-3">
                  <span className="text-sm font-medium text-muted-strong">Brief input</span>
                  <textarea
                    data-testid="brief-input"
                    value={brief}
                    onChange={(event) => setBrief(event.target.value)}
                    placeholder="Describe the ad you want to generate from approved assets."
                    className="min-h-52 w-full rounded-3xl border border-border bg-surface-elevated px-5 py-4 text-base leading-7 text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/25"
                  />
                </label>

                <div className="flex flex-col gap-4 rounded-3xl border border-border bg-surface-elevated/80 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <label className="flex items-center gap-3 text-sm leading-6 text-muted-strong">
                    <input
                      data-testid="fixture-mode-toggle"
                      type="checkbox"
                      checked={fixtureMode}
                      onChange={(event) => setFixtureMode(event.target.checked)}
                      className="h-4 w-4 rounded border-border bg-surface text-accent focus:ring-accent"
                    />
                    Use demo fixture mode
                  </label>

                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      data-testid="sample-brief-button"
                      type="button"
                      onClick={() => {
                        setBrief(SAMPLE_BRIEF);
                        setRequestError(null);
                      }}
                      className="inline-flex items-center justify-center rounded-full border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground transition hover:border-accent/40 hover:text-accent"
                    >
                      Load sample brief
                    </button>

                    <button
                      data-testid="generate-button"
                      type="button"
                      onClick={() => void handleGenerate()}
                      disabled={isStarting}
                      className="inline-flex items-center justify-center rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isStarting ? "Submitting…" : "Generate demo"}
                    </button>
                  </div>
                </div>

                {statusErrorMessage ? (
                  <div className="rounded-3xl border border-danger/30 bg-danger/12 px-4 py-3 text-sm leading-6 text-danger">
                    {statusErrorMessage}
                  </div>
                ) : null}

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
                        Approved assets
                      </h3>
                      <p className="text-sm leading-6 text-muted">
                        The policy-selected asset IDs for the current run appear here.
                      </p>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      {selectedAssets.length > 0 ? (
                        selectedAssets.map(({ assetId, asset }) => (
                          <article key={assetId} className="overflow-hidden rounded-2xl border border-border bg-surface">
                            {asset ? (
                              <img
                                src={`/assets/approved/${asset.filename}`}
                                alt={assetId}
                                className="h-32 w-full border-b border-border bg-background object-contain p-4"
                              />
                            ) : (
                              <div className="flex h-32 items-center justify-center border-b border-border bg-background text-sm text-muted">
                                Unknown asset preview
                              </div>
                            )}
                            <div className="space-y-2 p-4">
                              <p className="font-medium text-foreground">{assetId}</p>
                              <p className="text-sm text-muted">{asset?.filename ?? "Manifest details unavailable."}</p>
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
                          Approved asset IDs appear after the policy validation step succeeds.
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
                  <h2 className="text-xl font-semibold tracking-tight">Final playback</h2>
                  <p className="text-sm leading-6 text-muted">
                    Signed artifacts are served by the existing Task 8 artifact routes.
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

              <div className="rounded-3xl border border-border bg-surface-elevated p-4">
                <video
                  data-testid="video-player"
                  controls
                  preload="metadata"
                  src={runStatus?.resultUrl}
                  className={`w-full overflow-hidden rounded-2xl bg-slate-950 ${runStatus?.resultUrl ? "aspect-video" : "hidden"}`}
                />
                {!runStatus?.resultUrl ? (
                  <div className="flex aspect-video items-center justify-center rounded-2xl border border-dashed border-border bg-background/70 px-6 text-center text-sm leading-6 text-muted">
                    Final video playback appears here after the export step completes.
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          <aside className="space-y-6">
            <div className="panel px-6 py-6 lg:px-8">
              <div className="mb-5 space-y-1">
                <h2 className="text-xl font-semibold tracking-tight">Run progress</h2>
                <p className="text-sm leading-6 text-muted">
                  Each stage becomes visibly complete, active, or stopped as the run advances.
                </p>
              </div>

              <ol data-testid="status-timeline" className="space-y-3">
                {PHASE_STEPS.map((step, index) => {
                  const isCompleted = currentPhaseIndex > index || runStatus?.outcome === "ok";
                  const isCurrent = currentPhaseIndex === index && !isTerminalStatus(runStatus);
                  const isFailed = runStatus?.phase === "failed" && index === Math.max(currentPhaseIndex, 0);

                  return (
                    <li
                      key={step.phase}
                      className={`rounded-3xl border px-4 py-4 transition ${
                        isCompleted
                          ? "border-success/30 bg-success/12"
                          : isCurrent
                            ? "border-accent/30 bg-accent-soft"
                            : isFailed
                              ? "border-danger/30 bg-danger/12"
                              : "border-border bg-surface-elevated"
                      }`}
                    >
                      <div className="flex items-start gap-4">
                        <span
                          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold ${
                            isCompleted
                              ? "border-success/30 bg-success text-background"
                              : isCurrent
                                ? "border-accent/30 bg-accent text-slate-950"
                                : isFailed
                                  ? "border-danger/30 bg-danger text-white"
                                  : "border-border bg-surface text-muted"
                          }`}
                        >
                          {isCompleted ? "✓" : index + 1}
                        </span>
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium text-foreground">{step.label}</p>
                            {isCurrent ? (
                              <span className="rounded-full border border-accent/30 bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent">
                                Live
                              </span>
                            ) : null}
                            {isCompleted ? (
                              <span className="rounded-full border border-success/30 bg-success/15 px-2.5 py-0.5 text-xs font-medium text-success">
                                Done
                              </span>
                            ) : null}
                            {isFailed ? (
                              <span className="rounded-full border border-danger/30 bg-danger/15 px-2.5 py-0.5 text-xs font-medium text-danger">
                                Stopped
                              </span>
                            ) : null}
                          </div>
                          <p className="text-sm leading-6 text-muted">{step.detail}</p>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>

            <div data-testid="provenance-panel" className="panel px-6 py-6 lg:px-8">
              <div className="mb-5 space-y-1">
                <h2 className="text-xl font-semibold tracking-tight">Provenance</h2>
                <p className="text-sm leading-6 text-muted">
                  Source asset IDs, prompt metadata, and provider references stay visible for reviewer trust.
                </p>
              </div>

              <div className="space-y-4 text-sm leading-6">
                <div className="rounded-3xl border border-border bg-surface-elevated p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Source asset IDs</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {sourceAssets.length > 0 ? (
                      sourceAssets.map((assetId) => (
                        <span
                          key={assetId}
                          className="rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-muted-strong"
                        >
                          {assetId}
                        </span>
                      ))
                    ) : (
                      <p className="text-muted">
                        {isLoadingProvenance
                          ? "Loading provenance artifact…"
                          : "Source asset lineage will appear once the signed provenance artifact is available."}
                      </p>
                    )}
                  </div>
                </div>

                <div className="rounded-3xl border border-border bg-surface-elevated p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Prompt + model registry</p>
                  <div className="mt-3 space-y-3">
                    {Object.entries(provenancePrompts).length > 0 ? (
                      Object.entries(provenancePrompts).map(([stageName, entry]) => (
                        <div key={stageName} className="rounded-2xl border border-border bg-surface px-4 py-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="font-medium capitalize text-foreground">{stageName.replaceAll("_", " ")}</p>
                            {entry?.model ? (
                              <span className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-strong">
                                {entry.model}
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-2 text-muted">{entry?.prompt_id ?? "Prompt metadata unavailable."}</p>
                          <p className="text-xs text-muted">
                            v{entry?.version ?? "?"} · {entry?.template_hash ?? "no-template-hash"}
                          </p>
                        </div>
                      ))
                    ) : (
                      <p className="text-muted">Prompt registry metadata will load from the provenance artifact after export.</p>
                    )}
                  </div>
                </div>

                <div className="rounded-3xl border border-border bg-surface-elevated p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Provider references</p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-2xl border border-border bg-surface px-4 py-3">
                      <p className="font-medium text-foreground">Image generation</p>
                      <p className="mt-2 text-muted">
                        {imageProviderRefs.length > 0 ? imageProviderRefs.join(", ") : "No image provider jobs recorded yet."}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-border bg-surface px-4 py-3">
                      <p className="font-medium text-foreground">Video generation</p>
                      <p className="mt-2 text-muted">
                        {videoProviderRefs.length > 0 ? videoProviderRefs.join(", ") : "No video provider jobs recorded yet."}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="rounded-3xl border border-border bg-surface-elevated p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Artifact metadata</p>
                  <div className="mt-3 space-y-2 text-muted">
                    <p>
                      Final MP4 expires: {provenance?.signed_artifacts?.final_mp4?.expires_at ?? "Available after export"}
                    </p>
                    <p>
                      Duration / codec: {provenance?.export_metadata?.duration_seconds ?? "—"}s · {provenance?.export_metadata?.codec ?? "—"}
                    </p>
                    <p>
                      FPS / soundtrack: {provenance?.export_metadata?.fps ?? "—"} · {provenance?.export_metadata?.soundtrack ?? "—"}
                    </p>
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
      </div>
    </main>
  );
}
