import crypto from "node:crypto";

export const DEV_ARTIFACT_ROUTE_SIGNING_SECRET = "dev-artifact-route-secret";

export function computeArtifactRouteSignature(input: {
  runId: string;
  artifactName: string;
  expiresAtIso: string;
  signingSecret: string;
}): string {
  return crypto
    .createHmac("sha256", input.signingSecret)
    .update(`${input.runId}:${input.artifactName}:${input.expiresAtIso}`)
    .digest("hex");
}

export function resolveArtifactRouteSigningSecret(env: NodeJS.ProcessEnv, nodeEnv: string): string {
  const configured = env.ARTIFACT_ROUTE_SIGNING_SECRET?.trim();
  if (configured && configured.length > 0) {
    return configured;
  }

  if (nodeEnv === "production") {
    throw new Error("ARTIFACT_ROUTE_SIGNING_SECRET is required in production.");
  }

  return DEV_ARTIFACT_ROUTE_SIGNING_SECRET;
}
