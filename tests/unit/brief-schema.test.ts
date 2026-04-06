import { parseNormalizedBrief } from "@shared/index";
import validBriefFixture from "./fixtures/briefs/valid-brief.json";

describe("brief-schema", () => {
  test("parses a valid normalized brief fixture", () => {
    const parsed = parseNormalizedBrief(validBriefFixture);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    expect(parsed.value.scenes).toHaveLength(4);
    expect(parsed.value.scenes[1]?.visualCriticality).toBe("brand_critical");
  });

  test("rejects unexpected fields to keep schema closed", () => {
    const invalid = {
      ...validBriefFixture,
      freestyle: "not allowed",
    };

    const parsed = parseNormalizedBrief(invalid);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }

    expect(parsed.reasonCodes).toContain("brief_invalid_schema");
  });
});
