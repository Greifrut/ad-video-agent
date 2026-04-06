import {
  ASSET_TAGS,
  GENERATION_MODES,
  SCENE_TYPES,
  SHARED_CONTRACT_VERSION,
  TRANSFORM_OPERATIONS,
  VISUAL_CRITICALITY,
  type AssetTag,
  type FailureReasonCode,
  type GenerationMode,
  type SceneType,
  type TransformOperation,
  type VisualCriticality,
} from "./contracts";

export const BRIEF_SCHEMA_VERSION = SHARED_CONTRACT_VERSION;

const ASPECT_RATIOS = ["16:9", "9:16", "4:9", "1:1"] as const;
const LANGUAGES = ["en"] as const;

type AspectRatio = (typeof ASPECT_RATIOS)[number];
type LanguageCode = (typeof LANGUAGES)[number];

export interface NormalizedScene {
  sceneId: string;
  sceneType: SceneType;
  visualCriticality: VisualCriticality;
  narrative: string;
  desiredTags: readonly AssetTag[];
  approvedAssetIds: readonly string[];
  generationMode: GenerationMode;
  requestedTransform: TransformOperation;
  durationSeconds: number;
}

export interface NormalizedBrief {
  schemaVersion: typeof BRIEF_SCHEMA_VERSION;
  briefId: string;
  campaignName: string;
  objective: string;
  language: LanguageCode;
  aspectRatio: AspectRatio;
  unresolvedQuestions: readonly string[];
  scenes: readonly NormalizedScene[];
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reasonCodes: FailureReasonCode[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyAllowedKeys(record: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowedKeys.includes(key));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isEnumMember<T extends readonly string[]>(value: unknown, allowedValues: T): value is T[number] {
  return typeof value === "string" && allowedValues.includes(value);
}

function validateScene(scene: unknown): scene is NormalizedScene {
  if (!isRecord(scene)) {
    return false;
  }

  const allowedKeys = [
    "sceneId",
    "sceneType",
    "visualCriticality",
    "narrative",
    "desiredTags",
    "approvedAssetIds",
    "generationMode",
    "requestedTransform",
    "durationSeconds",
  ] as const;

  if (!hasOnlyAllowedKeys(scene, allowedKeys)) {
    return false;
  }

  return (
    typeof scene.sceneId === "string" &&
    scene.sceneId.length > 0 &&
    isEnumMember(scene.sceneType, SCENE_TYPES) &&
    isEnumMember(scene.visualCriticality, VISUAL_CRITICALITY) &&
    typeof scene.narrative === "string" &&
    scene.narrative.length > 0 &&
    Array.isArray(scene.desiredTags) &&
    scene.desiredTags.every((tag) => isEnumMember(tag, ASSET_TAGS)) &&
    isStringArray(scene.approvedAssetIds) &&
    isEnumMember(scene.generationMode, GENERATION_MODES) &&
    isEnumMember(scene.requestedTransform, TRANSFORM_OPERATIONS) &&
    typeof scene.durationSeconds === "number" &&
    Number.isFinite(scene.durationSeconds) &&
    scene.durationSeconds > 0 &&
      scene.durationSeconds <= 10
  );
}

export function parseNormalizedBrief(input: unknown): ParseResult<NormalizedBrief> {
  if (!isRecord(input)) {
    return { ok: false, reasonCodes: ["brief_invalid_schema"] };
  }

  const allowedRootKeys = [
    "schemaVersion",
    "briefId",
    "campaignName",
    "objective",
    "language",
    "aspectRatio",
    "unresolvedQuestions",
    "scenes",
  ] as const;

  if (!hasOnlyAllowedKeys(input, allowedRootKeys)) {
    return { ok: false, reasonCodes: ["brief_invalid_schema"] };
  }

  const schemaVersion = input.schemaVersion;
  const briefId = input.briefId;
  const campaignName = input.campaignName;
  const objective = input.objective;
  const scenes = input.scenes;
  const unresolvedQuestions = input.unresolvedQuestions;
  const language = input.language;
  const aspectRatio = input.aspectRatio;

  const missingRequiredField =
    typeof schemaVersion !== "string" ||
    typeof briefId !== "string" ||
    typeof campaignName !== "string" ||
    typeof objective !== "string" ||
    !Array.isArray(scenes);

  if (missingRequiredField) {
    return { ok: false, reasonCodes: ["brief_missing_required_field"] };
  }

  if (
    schemaVersion !== BRIEF_SCHEMA_VERSION ||
    !isEnumMember(language, LANGUAGES) ||
    !isEnumMember(aspectRatio, ASPECT_RATIOS) ||
    !isStringArray(unresolvedQuestions)
  ) {
    return { ok: false, reasonCodes: ["brief_invalid_schema"] };
  }

  const everySceneIsValid = scenes.every((scene) => validateScene(scene));
  if (!everySceneIsValid) {
    return { ok: false, reasonCodes: ["brief_invalid_schema"] };
  }

  return {
    ok: true,
    value: {
      schemaVersion,
      briefId,
      campaignName,
      objective,
      language,
      aspectRatio,
      unresolvedQuestions,
      scenes,
    },
  };
}
