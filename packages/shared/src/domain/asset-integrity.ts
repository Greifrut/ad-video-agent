import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FailureReasonCode } from "./contracts";
import type { ApprovedAssetManifest, ApprovedAssetRecord, AssetDimensions } from "./approved-assets";

export interface AssetObservedMetadata {
  sha256: string;
  canonicalMime: string;
  byteSize: number;
  dimensions: AssetDimensions;
}

export interface AssetIntegrityFailure {
  assetId: string;
  reasonCode: FailureReasonCode;
  message: string;
}

export interface AssetIntegrityCheckResult {
  ok: boolean;
  failures: AssetIntegrityFailure[];
}

function canonicalMimeFromFilename(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".svg") {
    return "image/svg+xml";
  }
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  return "application/octet-stream";
}

function dimensionsFromPng(buffer: Buffer): AssetDimensions {
  const pngSignature = "89504e470d0a1a0a";
  if (buffer.byteLength < 24 || buffer.subarray(0, 8).toString("hex") !== pngSignature) {
    throw new Error("PNG file is missing a valid signature");
  }

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function dimensionsFromSvg(svgBody: string): AssetDimensions {
  const widthMatch = svgBody.match(/width="(\d+)"/);
  const heightMatch = svgBody.match(/height="(\d+)"/);
  if (!widthMatch || !heightMatch) {
    throw new Error("SVG file is missing width/height attributes");
  }

  return {
    width: Number(widthMatch[1]),
    height: Number(heightMatch[1]),
  };
}

export async function buildObservedMetadata(filePath: string, filenameForMime: string): Promise<AssetObservedMetadata> {
  const body = await fs.readFile(filePath);
  const utf8 = body.toString("utf8");
  const dimensions = filenameForMime.endsWith(".svg")
    ? dimensionsFromSvg(utf8)
    : filenameForMime.endsWith(".png")
      ? dimensionsFromPng(body)
      : { width: 0, height: 0 };

  return {
    sha256: crypto.createHash("sha256").update(body).digest("hex"),
    canonicalMime: canonicalMimeFromFilename(filenameForMime),
    byteSize: body.length,
    dimensions,
  };
}

export function compareObservedMetadata(
  expected: ApprovedAssetRecord,
  observed: AssetObservedMetadata,
): AssetIntegrityCheckResult {
  const failures: AssetIntegrityFailure[] = [];

  if (expected.sha256 !== observed.sha256) {
    failures.push({
      assetId: expected.id,
      reasonCode: "asset_integrity_mismatch",
      message: `sha256 mismatch for ${expected.id}`,
    });
  }

  if (expected.canonicalMime !== observed.canonicalMime) {
    failures.push({
      assetId: expected.id,
      reasonCode: "asset_integrity_mismatch",
      message: `canonical MIME mismatch for ${expected.id}`,
    });
  }

  if (expected.byteSize !== observed.byteSize) {
    failures.push({
      assetId: expected.id,
      reasonCode: "asset_integrity_mismatch",
      message: `byte size mismatch for ${expected.id}`,
    });
  }

  if (
    expected.dimensions.width !== observed.dimensions.width ||
    expected.dimensions.height !== observed.dimensions.height
  ) {
    failures.push({
      assetId: expected.id,
      reasonCode: "asset_integrity_mismatch",
      message: `dimensions mismatch for ${expected.id}`,
    });
  }

  return {
    ok: failures.length === 0,
    failures,
  };
}

export async function validateAssetRecordIntegrity(
  asset: ApprovedAssetRecord,
  approvedAssetsRootDir: string,
): Promise<AssetIntegrityCheckResult> {
  const absolutePath = path.join(approvedAssetsRootDir, asset.filename);

  try {
    const observed = await buildObservedMetadata(absolutePath, asset.filename);
    return compareObservedMetadata(asset, observed);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {
        ok: false,
        failures: [
          {
            assetId: asset.id,
            reasonCode: "approved_asset_missing_on_disk",
            message: `approved asset file is missing: ${asset.filename}`,
          },
        ],
      };
    }

    return {
      ok: false,
      failures: [
        {
          assetId: asset.id,
          reasonCode: "asset_integrity_mismatch",
          message: `asset metadata invalid for ${asset.id}: ${error instanceof Error ? error.message : "unknown error"}`,
        },
      ],
    };
  }
}

export async function validateManifestIntegrity(
  manifest: ApprovedAssetManifest,
  approvedAssetsRootDir: string,
): Promise<AssetIntegrityCheckResult> {
  const results = await Promise.all(
    manifest.assets.map((asset) => validateAssetRecordIntegrity(asset, approvedAssetsRootDir)),
  );

  const failures = results.flatMap((result) => result.failures);
  return {
    ok: failures.length === 0,
    failures,
  };
}
