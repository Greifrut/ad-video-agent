import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  computeArtifactRouteSignature,
  loadBootstrapEnvironment,
  resolveArtifactRouteSigningSecret,
} from "@shared/index";
import { getRunEngine } from "@/app/api/_server/run-engine-instance";
import { jsonError } from "@/app/api/_server/http";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    runId: string;
    artifactName: string;
  }>;
};

type SignedRouteMetadata = {
  route_path: string;
  signed_path: string;
  expires_at: string;
  ttl_seconds: number;
};

type ArtifactRoutes = {
  final_mp4?: SignedRouteMetadata;
  provenance_json?: SignedRouteMetadata;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSignedRouteMetadata(result: Record<string, unknown> | null, artifactName: string): SignedRouteMetadata | null {
  if (!result || !isRecord(result.subtitles_export)) {
    return null;
  }

  const routes = result.subtitles_export.artifact_routes;
  if (!isRecord(routes)) {
    return null;
  }

  const key = artifactName === "final.mp4" ? "final_mp4" : artifactName === "provenance.json" ? "provenance_json" : null;
  if (!key) {
    return null;
  }

  const route = routes[key as keyof ArtifactRoutes];
  if (!isRecord(route)) {
    return null;
  }

  if (
    typeof route.route_path !== "string" ||
    typeof route.signed_path !== "string" ||
    typeof route.expires_at !== "string" ||
    typeof route.ttl_seconds !== "number"
  ) {
    return null;
  }

  return {
    route_path: route.route_path,
    signed_path: route.signed_path,
    expires_at: route.expires_at,
    ttl_seconds: route.ttl_seconds,
  };
}

function isSignedRequestValid(
  requestUrl: URL,
  signedRoute: SignedRouteMetadata,
  runId: string,
  artifactName: string,
  signingSecret: string,
): { ok: true } | { ok: false; code: "invalid_signature" | "signature_expired" } {
  const expires = requestUrl.searchParams.get("expires");
  const signature = requestUrl.searchParams.get("signature");
  if (!expires || !signature) {
    return { ok: false, code: "invalid_signature" };
  }

  const expectedSignature = computeArtifactRouteSignature({
    runId,
    artifactName,
    expiresAtIso: expires,
    signingSecret,
  });

  const provided = Buffer.from(signature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return { ok: false, code: "invalid_signature" };
  }

  const signedUrl = new URL(signedRoute.signed_path, "http://signed.local");
  const signedExpires = signedUrl.searchParams.get("expires");
  if (!signedExpires || signedExpires !== expires || signedRoute.expires_at !== expires) {
    return { ok: false, code: "invalid_signature" };
  }

  const expiresAtMs = Date.parse(signedRoute.expires_at);
  if (Number.isFinite(expiresAtMs) && Date.now() > expiresAtMs) {
    return { ok: false, code: "signature_expired" };
  }

  return { ok: true };
}

function contentTypeForArtifact(name: string): string {
  if (name === "final.mp4") {
    return "video/mp4";
  }

  return "application/json; charset=utf-8";
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { runId, artifactName } = await context.params;

  try {
    const engine = await getRunEngine();
    const projection = await engine.getRunProjection(runId);
    const signedRoute = readSignedRouteMetadata(projection.result, artifactName);
    if (!signedRoute) {
      return jsonError(404, "not_found", "Signed artifact route metadata not found.");
    }

    const bootstrap = loadBootstrapEnvironment(process.env);
    const signingSecret = resolveArtifactRouteSigningSecret(process.env, bootstrap.nodeEnv);

    const signatureCheck = isSignedRequestValid(
      new URL(request.url),
      signedRoute,
      runId,
      artifactName,
      signingSecret,
    );
    if (!signatureCheck.ok) {
      if (signatureCheck.code === "signature_expired") {
        return jsonError(410, "signature_expired", "Signed artifact link has expired.");
      }

      return jsonError(403, "invalid_signature", "Signed artifact link is invalid.");
    }

    const artifactPath = path.join(bootstrap.artifactsDir, "runs", runId, artifactName);
    const fileBuffer = await fs.readFile(artifactPath);

    return new Response(fileBuffer, {
      status: 200,
      headers: {
        "Content-Type": contentTypeForArtifact(artifactName),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("not found")) {
      return jsonError(404, "not_found", `Run ${runId} was not found.`);
    }

    return jsonError(500, "internal_error", "Failed to retrieve artifact.");
  }
}
