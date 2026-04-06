import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPreGeneratedImageGenerator } from "@shared/index";

describe("pre-generated image generator", () => {
  test("loads local scene stills from approved asset files", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deal-pump-pre-generated-"));
    await fs.writeFile(path.join(tempRoot, "01-hook-spokeswoman-dealpump.png"), Buffer.from("img-1"));
    await fs.writeFile(path.join(tempRoot, "02-product-demo-closeup.png"), Buffer.from("img-2"));

    const generator = createPreGeneratedImageGenerator({
      assetsRootDir: tempRoot,
    });

    const result = await generator.generate(
      {
        normalized_brief: {
          schemaVersion: "1.0.0",
          briefId: "brief-assets-1",
          campaignName: "Asset Load",
          objective: "Create a short ecommerce ad.",
          language: "en",
          aspectRatio: "4:9",
          unresolvedQuestions: [],
          scenes: [
            {
              sceneId: "scene-1",
              sceneType: "intro",
              visualCriticality: "supporting",
              narrative: "Open on the spokesperson hook.",
              desiredTags: ["hero"],
              approvedAssetIds: ["hook-spokeswoman-dealpump"],
              generationMode: "asset_derived",
              requestedTransform: "overlay",
              durationSeconds: 5,
            },
            {
              sceneId: "scene-2",
              sceneType: "product_focus",
              visualCriticality: "brand_critical",
              narrative: "Cut to the product demo close-up.",
              desiredTags: ["product", "packshot"],
              approvedAssetIds: ["product-demo-closeup"],
              generationMode: "asset_derived",
              requestedTransform: "animate",
              durationSeconds: 6,
            },
          ],
        },
      },
      "run-assets-1",
    );

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") {
      return;
    }

    expect(result.stageData.image_generation.source_asset_ids).toEqual([
      "hook-spokeswoman-dealpump",
      "product-demo-closeup",
    ]);
    expect(result.stageData.image_generation.derived_stills).toHaveLength(2);
    expect(result.stageData.image_generation.derived_stills[0]?.storage_path).toContain(
      "01-hook-spokeswoman-dealpump.png",
    );
  });
});
