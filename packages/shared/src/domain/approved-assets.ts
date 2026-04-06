import type {
  AssetTag,
  SceneType,
  TransformOperation,
  VisualCriticality,
} from "./contracts";

export const APPROVED_ASSET_MANIFEST_VERSION = "1.0.0" as const;

export const APPROVED_ASSET_MEDIA_TYPES = ["image", "video"] as const;

export type ApprovedAssetMediaType = (typeof APPROVED_ASSET_MEDIA_TYPES)[number];

export interface AssetDimensions {
  width: number;
  height: number;
}

export interface ApprovedAssetRecord {
  id: string;
  filename: string;
  mediaType: ApprovedAssetMediaType;
  sha256: string;
  canonicalMime: string;
  byteSize: number;
  dimensions: AssetDimensions;
  tags: readonly AssetTag[];
  visualCriticality: VisualCriticality;
  brandCritical: boolean;
  allowedTransforms: readonly TransformOperation[];
  sceneSuitability: readonly SceneType[];
}

export interface ApprovedAssetManifest {
  version: typeof APPROVED_ASSET_MANIFEST_VERSION;
  assets: readonly ApprovedAssetRecord[];
}

export const APPROVED_ASSET_MANIFEST: ApprovedAssetManifest = {
  version: APPROVED_ASSET_MANIFEST_VERSION,
  assets: [
    {
      id: "hook-spokeswoman-dealpump",
      filename: "01-hook-spokeswoman-dealpump.png",
      mediaType: "image",
      sha256: "c0232fc72d8753a2a2855f467a89a2e22f7d3a4a60a5bbe8c1368bafa7707133",
      canonicalMime: "image/png",
      byteSize: 7248011,
      dimensions: { width: 1536, height: 2752 },
      tags: ["hero", "social", "background"],
      visualCriticality: "supporting",
      brandCritical: false,
      allowedTransforms: ["none", "resize", "crop", "overlay", "color_grade", "animate"],
      sceneSuitability: ["background_plate", "intro"],
    },
    {
      id: "product-demo-closeup",
      filename: "02-product-demo-closeup.png",
      mediaType: "image",
      sha256: "e802f56e9319fe36b27d0b7ea980290dac56e90411fc65f4da9ef0873cb57e69",
      canonicalMime: "image/png",
      byteSize: 7118027,
      dimensions: { width: 1536, height: 2752 },
      tags: ["product", "packshot", "hero"],
      visualCriticality: "brand_critical",
      brandCritical: true,
      allowedTransforms: ["none", "resize", "crop", "overlay", "animate"],
      sceneSuitability: ["intro", "product_focus"],
    },
    {
      id: "social-proof-lifestyle",
      filename: "03-social-proof-lifestyle.png",
      mediaType: "image",
      sha256: "c542330fe7dfae9d1eef7ef29a1e5e71a3061c87eeb66371efe3cbcb88a4fd76",
      canonicalMime: "image/png",
      byteSize: 7742395,
      dimensions: { width: 1536, height: 2752 },
      tags: ["social", "hero", "background"],
      visualCriticality: "supporting",
      brandCritical: false,
      allowedTransforms: ["none", "resize", "crop", "overlay", "color_grade", "animate"],
      sceneSuitability: ["background_plate", "mascot_moment", "cta", "intro"],
    },
    {
      id: "closing-cta-packshot",
      filename: "04-closing-cta-packshot.png",
      mediaType: "image",
      sha256: "b5c46cc17f77c1197f676c526f536ad8efdf9c418fd500cd2e5a68966e5ce289",
      canonicalMime: "image/png",
      byteSize: 6825176,
      dimensions: { width: 1536, height: 2752 },
      tags: ["product", "packshot", "hero", "social"],
      visualCriticality: "brand_critical",
      brandCritical: true,
      allowedTransforms: ["none", "resize", "crop", "overlay", "animate"],
      sceneSuitability: ["cta", "product_focus"],
    },
  ],
};

export const APPROVED_ASSET_BY_ID: ReadonlyMap<string, ApprovedAssetRecord> = new Map(
  APPROVED_ASSET_MANIFEST.assets.map((asset) => [asset.id, asset]),
);
