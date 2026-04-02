import { expect, test } from "@playwright/test";

test("bootstrap shell renders", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Deal Pump bootstrap is ready" })).toBeVisible();
  await expect(page.getByText("pnpm verify && pnpm run-engine:check")).toBeVisible();
});
