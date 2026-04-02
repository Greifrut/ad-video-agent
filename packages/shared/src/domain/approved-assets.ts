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
      id: "brand-wordmark-primary",
      filename: "brand/dealpump-wordmark.svg",
      mediaType: "image",
      sha256: "38fa17fc7448484f939a24a5a85a1fb531796f0264bb471638987fa56596eb04",
      canonicalMime: "image/svg+xml",
      byteSize: 480,
      dimensions: { width: 1200, height: 320 },
      tags: ["logo", "hero"],
      visualCriticality: "brand_critical",
      brandCritical: true,
      allowedTransforms: ["none", "resize", "overlay"],
      sceneSuitability: ["intro", "cta", "product_focus"],
    },
    {
      id: "product-can-classic-packshot",
      filename: "products/dealpump-can-classic.svg",
      mediaType: "image",
      sha256: "848adde8883f856559f63e03d54010a97a18b983204b0fcb428650d50f254f1c",
      canonicalMime: "image/svg+xml",
      byteSize: 1211,
      dimensions: { width: 1024, height: 1024 },
      tags: ["product", "packshot", "hero"],
      visualCriticality: "brand_critical",
      brandCritical: true,
      allowedTransforms: ["none", "resize", "crop", "overlay", "animate"],
      sceneSuitability: ["product_focus", "cta"],
    },
    {
      id: "mascot-astro-pump-core",
      filename: "characters/mascot-astro-pump.svg",
      mediaType: "image",
      sha256: "cede44997b07dbbefb14dfeee96ef4dfacad548d15cf0a0eb79330ca548eda34",
      canonicalMime: "image/svg+xml",
      byteSize: 658,
      dimensions: { width: 800, height: 800 },
      tags: ["mascot", "social"],
      visualCriticality: "brand_critical",
      brandCritical: true,
      allowedTransforms: ["none", "resize", "overlay", "animate"],
      sceneSuitability: ["mascot_moment", "cta", "intro"],
    },
    {
      id: "studio-gradient-backdrop",
      filename: "backgrounds/studio-gradient.svg",
      mediaType: "image",
      sha256: "90790090a1ca0960c9f6edd32493177e8e4ad42bc3b322605db62a9c13298956",
      canonicalMime: "image/svg+xml",
      byteSize: 582,
      dimensions: { width: 1920, height: 1080 },
      tags: ["background", "studio"],
      visualCriticality: "supporting",
      brandCritical: false,
      allowedTransforms: ["none", "resize", "crop", "color_grade", "overlay"],
      sceneSuitability: ["intro", "background_plate", "product_focus", "cta"],
    },
  ],
};

export const APPROVED_ASSET_BY_ID: ReadonlyMap<string, ApprovedAssetRecord> = new Map(
  APPROVED_ASSET_MANIFEST.assets.map((asset) => [asset.id, asset]),
);
