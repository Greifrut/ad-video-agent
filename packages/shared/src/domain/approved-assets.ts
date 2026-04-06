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
      sha256: "",
      canonicalMime: "image/png",
      byteSize: 0,
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
      sha256: "",
      canonicalMime: "image/png",
      byteSize: 0,
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
      sha256: "",
      canonicalMime: "image/png",
      byteSize: 0,
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
      sha256: "",
      canonicalMime: "image/png",
      byteSize: 0,
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
