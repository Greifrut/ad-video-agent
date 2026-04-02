import {
  APPROVED_ASSET_MANIFEST,
  evaluateBriefPolicy,
  parseNormalizedBrief,
} from "@shared/index";
import ambiguousBriefFixture from "./fixtures/briefs/ambiguous-brief.json";
import noMatchBriefFixture from "./fixtures/briefs/no-match-brief.json";
import blockedBriefFixture from "./fixtures/briefs/policy-blocked-brief.json";
import validBriefFixture from "./fixtures/briefs/valid-brief.json";

function parseFixture(input: unknown) {
  const parsed = parseNormalizedBrief(input);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    throw new Error(`Fixture parse failed: ${parsed.reasonCodes.join(",")}`);
  }

  return parsed.value;
}

describe("asset-policy", () => {
  test("returns ok for valid brief mapped to approved assets", () => {
    const brief = parseFixture(validBriefFixture);
    const result = evaluateBriefPolicy(brief, APPROVED_ASSET_MANIFEST);

    expect(result.outcome).toBe("ok");
    expect(result.reasonCodes).toEqual([]);
  });

  test("returns needs_clarification for ambiguous brief", () => {
    const brief = parseFixture(ambiguousBriefFixture);
    const result = evaluateBriefPolicy(brief, APPROVED_ASSET_MANIFEST);

    expect(result.outcome).toBe("needs_clarification");
    expect(result.reasonCodes).toContain("brief_ambiguous_visual_intent");
  });

  test("blocks invented brand-critical media", () => {
    const brief = parseFixture(blockedBriefFixture);
    const result = evaluateBriefPolicy(brief, APPROVED_ASSET_MANIFEST);

    expect(result.outcome).toBe("policy_blocked");
    expect(result.reasonCodes).toContain("invented_brand_critical_media");
    expect(result.reasonCodes).toContain("brand_critical_asset_required");
  });

  test("returns needs_clarification when no approved assets match", () => {
    const brief = parseFixture(noMatchBriefFixture);
    const result = evaluateBriefPolicy(brief, APPROVED_ASSET_MANIFEST);

    expect(result.outcome).toBe("needs_clarification");
    expect(result.reasonCodes).toContain("brief_no_asset_match");
  });
});
