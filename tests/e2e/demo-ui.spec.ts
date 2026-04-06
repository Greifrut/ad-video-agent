import { expect, test } from "@playwright/test";

test.describe("public demo UI", () => {
  test("happy path completes with fixture mode playback and provenance", async ({ page }) => {
    test.setTimeout(90_000);

    await page.goto("/");

    await expect(page.getByTestId("brief-input")).toHaveValue(/Deal Pump social ad/);
    await expect(page.getByTestId("fixture-mode-toggle")).toBeChecked();

    await page.getByTestId("sample-brief-button").click();
    await page.getByTestId("generate-button").click();

    await expect(page.getByTestId("status-timeline")).toContainText("Completed", {
      timeout: 60_000,
    });
    await expect(page.getByTestId("video-player")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("normalized-json")).toContainText("campaignName");
    await expect(page.getByTestId("selected-assets")).toContainText("hook-spokeswoman-dealpump");
    await expect(page.getByTestId("provenance-panel")).toContainText("Source asset IDs", {
      timeout: 60_000,
    });
    await expect(page.getByTestId("provenance-panel")).toContainText("normalize_brief_fixture_runtime");
    await expect(page.getByTestId("provenance-panel")).toContainText("use_pre_generated_scene_assets_v1");
    await expect(page.getByTestId("provenance-panel")).toContainText("generate_scene_video_veo_3_1_i2v");
    await expect(page.getByTestId("provenance-panel")).toContainText("assemble_scene_audio_export_v1");

    const videoSource = await page.getByTestId("video-player").getAttribute("src");
    expect(videoSource).toContain("/api/v1/runs/");
    expect(videoSource).toContain("final.mp4");
  });

  test("blocked path shows a readable policy message and no video", async ({ page }) => {
    await page.route("**/api/v1/runs", async (route) => {
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ runId: "run-blocked-demo" }),
      });
    });

    await page.route("**/api/v1/runs/run-blocked-demo", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          runId: "run-blocked-demo",
          phase: "failed",
          outcome: "needs_clarification",
          errorCode: "brief_no_asset_match",
          normalizedBrief: {
            objective: "Invent a brand-new logo and mascot from scratch",
          },
        }),
      });
    });

    await page.goto("/");
    await page.getByTestId("brief-input").fill("Invent a brand-new logo and mascot from scratch.");
    await page.getByTestId("generate-button").click();

    await expect(
      page
        .getByText("The script did not map cleanly to the predefined scene assets, so it needs clarification.")
        .first(),
    ).toBeVisible();
    await expect(page.getByTestId("video-player")).toBeHidden();
  });

  test("live mode loads a different sample brief", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByTestId("brief-input")).toHaveValue(/Deal Pump social ad/);
    await page.getByTestId("fixture-mode-toggle").uncheck();

    await expect(page.getByTestId("brief-input")).toHaveValue(/Create a short 4:9 vertical product video for Deal Pump/);
    await expect(page.getByTestId("brief-input")).toHaveValue(/presenter introduces the product with natural hand gestures/);
    await expect(page.getByTestId("brief-input")).toHaveValue(/clean product-focused closing frame/);
  });

  test("provider failure shows actionable Veo guidance", async ({ page }) => {
    await page.route("**/api/v1/runs", async (route) => {
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ runId: "run-provider-demo" }),
      });
    });

    await page.route("**/api/v1/runs/run-provider-demo", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          runId: "run-provider-demo",
          phase: "failed",
          outcome: "provider_failed",
          errorCode: "provider_failed",
          failureType: "provider_failed_status",
          providerReason:
            "The prompt could not be submitted. This prompt contains words that violate Vertex AI's usage guidelines.",
          sceneId: "scene_1",
        }),
      });
    });

    await page.goto("/");
    await page.getByTestId("generate-button").click();

    await expect(page.getByText("Veo rejected the prompt for scene_1.")).toBeVisible();
    await expect(page.getByText(/Provider note:/)).toBeVisible();
    await expect(page.getByText(/Simplify the scene into neutral visual direction/)).toBeVisible();
  });
});
