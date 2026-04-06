export type ProviderMode = "fixture" | "live";

export type RouteDecisionTrigger = "provider_mode_fixture" | "fixture_mode_payload" | "live_mode";

export type RouteDecision = {
  selectedRoute: ProviderMode;
  trigger: RouteDecisionTrigger;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readRequestedFixtureMode(payload: unknown): boolean | null {
  if (!isRecord(payload) || typeof payload.fixture_mode !== "boolean") {
    return null;
  }

  return payload.fixture_mode;
}

export function resolveRouteDecision(providerMode: ProviderMode, payload: unknown): RouteDecision {
  const requestedFixtureMode = readRequestedFixtureMode(payload);
  if (requestedFixtureMode !== null) {
    return {
      selectedRoute: requestedFixtureMode ? "fixture" : "live",
      trigger: "fixture_mode_payload",
    };
  }

  if (providerMode === "fixture") {
    return {
      selectedRoute: "fixture",
      trigger: "provider_mode_fixture",
    };
  }

  return {
    selectedRoute: "live",
    trigger: "live_mode",
  };
}
