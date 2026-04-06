import {
  defaultFixtureModeForEnvironment,
  sampleBriefForMode,
} from "../../components/public-demo-config";

describe("public-demo-config", () => {
  test("defaults to live mode in production", () => {
    expect(defaultFixtureModeForEnvironment("production")).toBe(false);
  });

  test("keeps fixture mode enabled outside production", () => {
    expect(defaultFixtureModeForEnvironment("development")).toBe(true);
    expect(defaultFixtureModeForEnvironment("test")).toBe(true);
    expect(defaultFixtureModeForEnvironment(undefined)).toBe(true);
  });

  test("loads different sample briefs per mode", () => {
    expect(sampleBriefForMode(true)).toContain("Deal Pump social ad");
    expect(sampleBriefForMode(false)).toContain("short 4:9 vertical product video");
  });
});
