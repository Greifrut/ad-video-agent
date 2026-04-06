import fs from "node:fs/promises";
import path from "node:path";
import { APPROVED_ASSET_MANIFEST } from "@shared/index";

function readPngDimensions(buffer: Buffer): { width: number; height: number } | null {
  const pngSignature = "89504e470d0a1a0a";
  if (buffer.byteLength < 24 || buffer.subarray(0, 8).toString("hex") !== pngSignature) {
    return null;
  }

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

describe("approved asset manifest", () => {
  test("keeps shipped asset dimensions aligned with the actual PNG files", async () => {
    const assetsRootDir = path.resolve(process.cwd(), "public/assets/approved");

    for (const asset of APPROVED_ASSET_MANIFEST.assets) {
      const filePath = path.join(assetsRootDir, asset.filename);
      const bytes = await fs.readFile(filePath);
      const dimensions = readPngDimensions(bytes);

      expect(dimensions).not.toBeNull();
      expect(dimensions).toEqual(asset.dimensions);
    }
  });
});
