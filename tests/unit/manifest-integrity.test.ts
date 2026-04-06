import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  APPROVED_ASSET_MANIFEST,
  buildObservedMetadata,
  compareObservedMetadata,
  validateAssetRecordIntegrity,
  validateManifestIntegrity,
} from "@shared/index";

const approvedAssetsRoot = path.join(process.cwd(), "public", "assets", "approved");

describe("manifest-integrity", () => {
  test("passes for checked-in approved asset manifest", async () => {
    const result = await validateManifestIntegrity(APPROVED_ASSET_MANIFEST, approvedAssetsRoot);

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test("fails when hash metadata does not match file", async () => {
    const target = APPROVED_ASSET_MANIFEST.assets[0];
    if (!target) {
      throw new Error("Expected at least one approved asset");
    }

    const observed = await buildObservedMetadata(
      path.join(approvedAssetsRoot, target.filename),
      target.filename,
    );

    const mismatch = compareObservedMetadata(
      {
        ...target,
        sha256: "0".repeat(64),
      },
      observed,
    );

    expect(mismatch.ok).toBe(false);
    expect(mismatch.failures.some((failure) => failure.message.includes("sha256 mismatch"))).toBe(true);
  });

  test("fails when MIME, byte size, or dimensions mismatch", async () => {
    const target = APPROVED_ASSET_MANIFEST.assets[1];
    if (!target) {
      throw new Error("Expected at least two approved assets");
    }

    const observed = await buildObservedMetadata(
      path.join(approvedAssetsRoot, target.filename),
      target.filename,
    );

    const mismatch = compareObservedMetadata(
      {
        ...target,
        canonicalMime: "image/jpeg",
        byteSize: target.byteSize + 1,
        dimensions: { width: target.dimensions.width + 1, height: target.dimensions.height },
      },
      observed,
    );

    expect(mismatch.ok).toBe(false);
    expect(mismatch.failures).toHaveLength(3);
  });

  test("labels missing files as approved_asset_missing_on_disk", async () => {
    const target = APPROVED_ASSET_MANIFEST.assets[0];
    if (!target) {
      throw new Error("Expected at least one approved asset");
    }

    const result = await validateAssetRecordIntegrity(target, path.join(approvedAssetsRoot, "_missing-root_"));

    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.reasonCode).toBe("approved_asset_missing_on_disk");
  });

  test("labels malformed existing files as asset_integrity_mismatch", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deal-pump-manifest-integrity-"));
    const malformedFilePath = path.join(tempRoot, "malformed.svg");
    await fs.writeFile(malformedFilePath, '<svg xmlns="http://www.w3.org/2000/svg"><g /></svg>', "utf8");

    const source = APPROVED_ASSET_MANIFEST.assets[0];
    if (!source) {
      throw new Error("Expected at least one approved asset");
    }

    const result = await validateAssetRecordIntegrity(
      {
        ...source,
        id: "temp-malformed-svg",
        filename: "malformed.svg",
      },
      tempRoot,
    );

    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.reasonCode).toBe("asset_integrity_mismatch");
    expect(result.failures[0]?.message).toContain("asset metadata invalid");
  });
});
