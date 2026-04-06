export const SHARED_CONTRACT_VERSION = "1.0.0" as const;

export const RUN_PHASES = [
  "submitted",
  "normalizing",
  "policy_validating",
  "generating_images",
  "generating_video",
  "exporting",
  "completed",
  "failed",
] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

export const RUN_OUTCOMES = [
  "none",
  "ok",
  "needs_clarification",
  "policy_blocked",
  "provider_failed",
] as const;

export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export const FAILURE_REASON_CODES = [
  "brief_missing_required_field",
  "brief_invalid_schema",
  "brief_ambiguous_visual_intent",
  "brief_no_asset_match",
  "invented_brand_critical_media",
  "brand_critical_asset_required",
  "asset_not_approved",
  "asset_scene_unsuitable",
  "asset_transform_not_allowed",
  "asset_integrity_mismatch",
  "approved_asset_missing_on_disk",
  "external_asset_source_forbidden",
] as const;

export type FailureReasonCode = (typeof FAILURE_REASON_CODES)[number];

export const SCENE_TYPES = [
  "intro",
  "product_focus",
  "mascot_moment",
  "cta",
  "background_plate",
] as const;

export type SceneType = (typeof SCENE_TYPES)[number];

export const VISUAL_CRITICALITY = ["brand_critical", "supporting"] as const;

export type VisualCriticality = (typeof VISUAL_CRITICALITY)[number];

export const GENERATION_MODES = ["asset_derived", "text_only"] as const;

export type GenerationMode = (typeof GENERATION_MODES)[number];

export const TRANSFORM_OPERATIONS = [
  "none",
  "crop",
  "resize",
  "overlay",
  "color_grade",
  "animate",
] as const;

export type TransformOperation = (typeof TRANSFORM_OPERATIONS)[number];

export const ASSET_TAGS = [
  "logo",
  "product",
  "mascot",
  "background",
  "studio",
  "hero",
  "social",
  "packshot",
] as const;

export type AssetTag = (typeof ASSET_TAGS)[number];

export type PolicyOutcome = Extract<RunOutcome, "ok" | "needs_clarification" | "policy_blocked">;
