import {
  computeArtifactRouteSignature,
  DEV_ARTIFACT_ROUTE_SIGNING_SECRET,
  resolveArtifactRouteSigningSecret,
} from "@shared/index";

describe("artifact-signing", () => {
  test("computes deterministic HMAC signatures", () => {
    const first = computeArtifactRouteSignature({
      runId: "run-1",
      artifactName: "final.mp4",
      expiresAtIso: "2036-04-02T12:00:00.000Z",
      signingSecret: "secret-1",
    });
    const second = computeArtifactRouteSignature({
      runId: "run-1",
      artifactName: "final.mp4",
      expiresAtIso: "2036-04-02T12:00:00.000Z",
      signingSecret: "secret-1",
    });
    const different = computeArtifactRouteSignature({
      runId: "run-1",
      artifactName: "provenance.json",
      expiresAtIso: "2036-04-02T12:00:00.000Z",
      signingSecret: "secret-1",
    });

    expect(first).toBe(second);
    expect(first).not.toBe(different);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  test("fails closed in production when secret is missing", () => {
    expect(() => resolveArtifactRouteSigningSecret({ NODE_ENV: "production" }, "production")).toThrow(
      "ARTIFACT_ROUTE_SIGNING_SECRET is required in production.",
    );
  });

  test("uses development fallback secret when missing outside production", () => {
    const resolved = resolveArtifactRouteSigningSecret({ NODE_ENV: "development" }, "development");
    expect(resolved).toBe(DEV_ARTIFACT_ROUTE_SIGNING_SECRET);
  });
});
