import type { NextRequest } from "next/server";

export const MAX_START_BODY_BYTES = 10 * 1024;

export type ApiErrorCode =
  | "invalid_json"
  | "body_too_large"
  | "invalid_request"
  | "missing_idempotency_key"
  | "not_found"
  | "rate_limited"
  | "invalid_signature"
  | "signature_expired"
  | "internal_error";

export function jsonError(status: number, code: ApiErrorCode, message: string, details?: Record<string, unknown>): Response {
  return Response.json(
    {
      error: {
        code,
        message,
        ...(details ?? {}),
      },
    },
    { status },
  );
}

export function readClientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = request.headers.get("x-real-ip")?.trim();

  if (forwarded) {
    return forwarded;
  }

  if (realIp) {
    return realIp;
  }

  return "unknown";
}

export function extractIdempotencyKey(request: NextRequest): string | null {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) {
    return null;
  }

  return key;
}

export async function parseLimitedJsonBody(request: NextRequest, maxBytes = MAX_START_BODY_BYTES): Promise<
  | { ok: true; value: unknown }
  | { ok: false; errorResponse: Response }
> {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return {
        ok: false,
        errorResponse: jsonError(413, "body_too_large", "Request body exceeds 10 KB limit."),
      };
    }
  }

  const raw = await request.text();
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > maxBytes) {
    return {
      ok: false,
      errorResponse: jsonError(413, "body_too_large", "Request body exceeds 10 KB limit."),
    };
  }

  try {
    return {
      ok: true,
      value: JSON.parse(raw),
    };
  } catch {
    return {
      ok: false,
      errorResponse: jsonError(400, "invalid_json", "Request body must be valid JSON."),
    };
  }
}
