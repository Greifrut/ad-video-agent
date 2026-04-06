import type { NextRequest } from "next/server";
import { getRunEngine } from "@/app/api/_server/run-engine-instance";
import {
  extractIdempotencyKey,
  jsonError,
  parseLimitedJsonBody,
  readClientIp,
} from "@/app/api/_server/http";
import { takeStartRateLimit } from "@/app/api/_server/rate-limit";

export const runtime = "nodejs";

type StartRunRequest = {
  brief: string;
  fixtureMode?: boolean;
};

function isStartRunRequest(value: unknown): value is StartRunRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const payload = value as Record<string, unknown>;
  const allowed = new Set(["brief", "fixtureMode"]);
  const hasOnlyKnownKeys = Object.keys(payload).every((key) => allowed.has(key));
  if (!hasOnlyKnownKeys) {
    return false;
  }

  if (typeof payload.brief !== "string" || payload.brief.trim().length === 0) {
    return false;
  }

  if (payload.fixtureMode !== undefined && typeof payload.fixtureMode !== "boolean") {
    return false;
  }

  return true;
}

export async function POST(request: NextRequest): Promise<Response> {
  const idempotencyKey = extractIdempotencyKey(request);
  if (!idempotencyKey) {
    return jsonError(400, "missing_idempotency_key", "Idempotency-Key header is required.");
  }

  const ip = readClientIp(request);
  const rate = takeStartRateLimit(ip);
  if (!rate.ok) {
    return Response.json(
      {
        error: {
          code: "rate_limited",
          message: "Start rate limit exceeded. Retry later.",
          retryAfterSeconds: rate.retryAfterSeconds,
        },
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(rate.retryAfterSeconds),
        },
      },
    );
  }

  const parsedBody = await parseLimitedJsonBody(request);
  if (!parsedBody.ok) {
    return parsedBody.errorResponse;
  }

  if (!isStartRunRequest(parsedBody.value)) {
    return jsonError(400, "invalid_request", "Body must match schema: { brief: string, fixtureMode?: boolean }.");
  }

  try {
    const engine = await getRunEngine();
    const started = await engine.startRun({
      idempotencyKey,
      payload: {
        brief: parsedBody.value.brief,
        fixture_mode: parsedBody.value.fixtureMode ?? false,
      },
    });

    return Response.json(
      {
        runId: started.runId,
      },
      {
        status: started.reused ? 200 : 202,
      },
    );
  } catch (error) {
    console.error("[api][runs][start] failed to start run", { idempotencyKey, error });
    return jsonError(500, "internal_error", "Failed to start run.");
  }
}
