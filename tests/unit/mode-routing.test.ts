import { describe, expect, test } from "vitest";
import { resolveRouteDecision } from "../../worker/src/mode-routing";

describe("mode routing", () => {
  test("uses request fixture mode when web explicitly asks for live", () => {
    expect(resolveRouteDecision("fixture", { fixture_mode: false })).toEqual({
      selectedRoute: "live",
      trigger: "fixture_mode_payload",
    });
  });

  test("uses request fixture mode when web explicitly asks for fixture", () => {
    expect(resolveRouteDecision("live", { fixture_mode: true })).toEqual({
      selectedRoute: "fixture",
      trigger: "fixture_mode_payload",
    });
  });

  test("falls back to worker provider mode when request does not specify mode", () => {
    expect(resolveRouteDecision("fixture", { brief: "hello" })).toEqual({
      selectedRoute: "fixture",
      trigger: "provider_mode_fixture",
    });

    expect(resolveRouteDecision("live", { brief: "hello" })).toEqual({
      selectedRoute: "live",
      trigger: "live_mode",
    });
  });
});
