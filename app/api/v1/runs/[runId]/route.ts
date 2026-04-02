import type { NextRequest } from "next/server";
import { getRunEngine } from "@/app/api/_server/run-engine-instance";
import { jsonError, readClientIp } from "@/app/api/_server/http";
import { takeStatusRateLimit } from "@/app/api/_server/rate-limit";
import { serializeRunStatus } from "@/app/api/_server/status-serializer";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    runId: string;
  }>;
};

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const ip = readClientIp(request);
  const rate = takeStatusRateLimit(ip);
  if (!rate.ok) {
    return Response.json(
      {
        error: {
          code: "rate_limited",
          message: "Status rate limit exceeded. Retry later.",
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

  const { runId } = await context.params;
  if (!runId) {
    return jsonError(400, "invalid_request", "runId path param is required.");
  }

  try {
    const engine = await getRunEngine();
    const projection = await engine.getRunProjection(runId);

    return Response.json(serializeRunStatus(projection));
  } catch (error) {
    if (error instanceof Error && error.message.includes("not found")) {
      return jsonError(404, "not_found", `Run ${runId} was not found.`);
    }

    return jsonError(500, "internal_error", "Failed to read run status.");
  }
}
