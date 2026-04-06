import crypto from "node:crypto";
import type { RunOutcome, RunPhase } from "../domain/contracts";

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const serializedEntries = entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`);
  return `{${serializedEntries.join(",")}}`;
}

export function hashSha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function computeEventDigest(input: {
  runId: string;
  sequence: number;
  eventType: string;
  phase: RunPhase;
  outcome: RunOutcome;
  payload: Record<string, unknown>;
  prevDigest: string | null;
}): string {
  return hashSha256(
    [
      input.runId,
      String(input.sequence),
      input.eventType,
      input.phase,
      input.outcome,
      stableJson(input.payload),
      input.prevDigest ?? "",
    ].join("|"),
  );
}
