import { createRuntimeValidatePolicyStageHandler } from "@shared/index";

type ValidatePolicySuccessData = {
  validate_policy: {
    selected_asset_ids: string[];
    reason_codes?: string[];
  };
  normalized_brief: {
    scenes: Array<{
      approvedAssetIds: string[];
      generationMode: string;
    }>;
  };
};

type ValidatePolicyTerminalData = {
  validate_policy: {
    reason_codes: string[];
  };
};

describe("runtime stage handlers", () => {
  test("validate policy enriches approved assets from desired tags for live-ready briefs", async () => {
    const handler = createRuntimeValidatePolicyStageHandler();

    const result = await handler({
      runId: "run-live-brief",
      stage: "validate_policy",
      attemptCount: 1,
      payload: {
        normalized_brief: {
          schemaVersion: "1.0.0",
          briefId: "brief-live-1",
          campaignName: "Live Brief",
          objective: "Create a polished social ad from approved assets.",
          language: "en",
          aspectRatio: "16:9",
          unresolvedQuestions: [],
          scenes: [
            {
              sceneId: "scene-intro",
              sceneType: "intro",
              visualCriticality: "supporting",
              narrative: "A spokesperson opens on the Deal Pump wordmark over the studio gradient.",
              desiredTags: ["logo", "background"],
              approvedAssetIds: [],
              generationMode: "text_only",
              requestedTransform: "overlay",
              durationSeconds: 5,
            },
            {
              sceneId: "scene-product",
              sceneType: "product_focus",
              visualCriticality: "brand_critical",
              narrative: "The approved can packshot lands with energetic motion.",
              desiredTags: ["product", "packshot"],
              approvedAssetIds: [],
              generationMode: "text_only",
              requestedTransform: "animate",
              durationSeconds: 6,
            },
          ],
        },
      },
    });

    expect(result.type).toBe("success");
    if (result.type !== "success") {
      return;
    }

    const data = result.data as ValidatePolicySuccessData;

    expect(data.validate_policy.selected_asset_ids).toEqual([
      "hook-spokeswoman-dealpump",
      "product-demo-closeup",
    ]);
    expect(data.normalized_brief).toMatchObject({
      scenes: [
        {
          approvedAssetIds: ["hook-spokeswoman-dealpump"],
          generationMode: "asset_derived",
        },
        {
          approvedAssetIds: ["product-demo-closeup"],
          generationMode: "asset_derived",
        },
      ],
    });
  });

  test("validate policy asks for clarification when no predefined scene asset matches", async () => {
    const handler = createRuntimeValidatePolicyStageHandler();

    const result = await handler({
      runId: "run-no-match",
      stage: "validate_policy",
      attemptCount: 1,
      payload: {
        normalized_brief: {
          schemaVersion: "1.0.0",
          briefId: "brief-no-match",
          campaignName: "No Match",
          objective: "Create a warehouse robotics explainer with no people or product demo.",
          language: "en",
          aspectRatio: "16:9",
          unresolvedQuestions: [],
          scenes: [
            {
              sceneId: "scene-cta",
              sceneType: "product_focus",
              visualCriticality: "supporting",
              narrative: "A futuristic warehouse robot explains logistics automation in a dark factory.",
              desiredTags: [],
              approvedAssetIds: [],
              generationMode: "text_only",
              requestedTransform: "color_grade",
              durationSeconds: 5,
            },
          ],
        },
      },
    });

    expect(result.type).toBe("terminal_outcome");
    if (result.type !== "terminal_outcome") {
      return;
    }

    const data = result.data as ValidatePolicyTerminalData;

    expect(result.outcome).toBe("needs_clarification");
    expect(data.validate_policy.reason_codes).toContain("brief_no_asset_match");
  });
});
