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
    await expect(page.getByTestId("selected-assets")).toContainText("brand-wordmark-primary");
    await expect(page.getByTestId("provenance-panel")).toContainText("Source asset IDs", {
      timeout: 60_000,
    });
    await expect(page.getByTestId("provenance-panel")).toContainText("fixture-runtime");

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
          outcome: "policy_blocked",
          errorCode: "invented_brand_critical_media",
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
        .getByText("Blocked because the request asks for invented brand-critical media rather than approved assets.")
        .first(),
    ).toBeVisible();
    await expect(page.getByTestId("video-player")).toBeHidden();
  });
});
