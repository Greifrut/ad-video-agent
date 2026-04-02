import type {
  RunEngineStage,
  StageHandlerContext,
  StageHandler,
  StageHandlerResult,
  StageHandlers,
} from "./types";
import { createOpenAINormalizer, type OpenAIResponsesClient } from "../domain/openai-normalizer";
import {
  createGeminiImageGenerator,
  type GeminiFlashImageClient,
} from "../domain/gemini-image";
import {
  createVeoVideoGenerator,
  type VeoVideoClient,
} from "../domain/veo-video";
import {
  createSubtitlesExportGenerator,
  type MediaCommandRunner,
} from "../domain/subtitles-export";

type MockPlan = {
  transient_failures?: Partial<Record<RunEngineStage, number>>;
  fatal_stages?: RunEngineStage[];
};

function parseMockPlan(payload: unknown): MockPlan {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  const value = payload as { mock_plan?: MockPlan };
  return value.mock_plan ?? {};
}

async function runMockStage(context: StageHandlerContext): Promise<StageHandlerResult> {
  const mockPlan = parseMockPlan(context.payload);
  const transientTarget = mockPlan.transient_failures?.[context.stage] ?? 0;

  if ((mockPlan.fatal_stages ?? []).includes(context.stage)) {
    return {
      type: "fatal_error",
      reason: `mock fatal error for stage ${context.stage}`,
    };
  }

  if (context.attemptCount <= transientTarget) {
    return {
      type: "retryable_error",
      reason: `mock retryable error for stage ${context.stage} (attempt ${context.attemptCount})`,
    };
  }

  return {
    type: "success",
    data: {
      stage: context.stage,
      artifact_path: `mock://${context.runId}/${context.stage}`,
      attempt: context.attemptCount,
    },
    providerRef: `mock-job-${context.runId}-${context.stage}-${context.attemptCount}`,
  };
}

export type StageHandlerFactoryOptions = {
  normalize?: StageHandler;
  validatePolicy?: StageHandler;
  imageGeneration?: StageHandler;
  videoGeneration?: StageHandler;
  subtitlesExport?: StageHandler;
};

export type OpenAINormalizeStageOptions = {
  client: OpenAIResponsesClient;
  model?: string;
  maxInputChars?: number;
};

export type GeminiImageStageOptions = {
  client: GeminiFlashImageClient;
  model?: string;
  approvedAssetsRootDir?: string;
};

export type VeoVideoStageOptions = {
  client: VeoVideoClient;
  model?: string;
  clock?: {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
  };
};

export type SubtitlesExportStageOptions = {
  artifactsRootDir: string;
  tempRootDir?: string;
  fixtureMode?: boolean;
  commandRunner?: MediaCommandRunner;
  routeSigningSecret?: string;
  now?: () => Date;
};

export function createOpenAINormalizeStageHandler(
  options: OpenAINormalizeStageOptions,
): StageHandler {
  const normalizer = createOpenAINormalizer({
    client: options.client,
    model: options.model,
    maxInputChars: options.maxInputChars,
  });

  return async (context) => {
    const result = await normalizer.normalize(context.payload);

    if (result.outcome === "provider_failed") {
      return {
        type: "fatal_error",
        reason: result.reason,
      };
    }

    const stageData = {
      normalize: {
        prompt_metadata: result.promptMetadata,
        repair_attempted: result.repairAttempted,
        sanitized_brief: result.sanitizedBrief,
        normalized_brief: result.outcome === "ok" ? result.normalizedBrief : null,
        reason_codes: result.outcome === "needs_clarification" ? result.reasonCodes : [],
      },
    };

    if (result.outcome === "needs_clarification") {
      return {
        type: "terminal_outcome",
        outcome: "needs_clarification",
        reason: "normalize stage requires clarification after one repair attempt",
        data: stageData,
        providerRef: result.providerRef ?? undefined,
      };
    }

    return {
      type: "success",
      data: stageData,
      providerRef: result.providerRef ?? undefined,
    };
  };
}

export function createGeminiImageStageHandler(options: GeminiImageStageOptions): StageHandler {
  const generator = createGeminiImageGenerator({
    client: options.client,
    model: options.model,
    approvedAssetsRootDir: options.approvedAssetsRootDir,
  });

  return async (context) => {
    let result: Awaited<ReturnType<typeof generator.generate>>;
    try {
      result = await generator.generate(context.payload, context.runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "gemini image generation failed";
      return {
        type: "fatal_error",
        reason: message,
      };
    }

    if (result.outcome === "ok") {
      return {
        type: "success",
        data: result.stageData,
        providerRef: result.providerRef ?? undefined,
      };
    }

    return {
      type: "terminal_outcome",
      outcome: result.outcome,
      reason: `${result.reason} (${result.reasonCodes.join(",")})`,
      data: {
        image_generation: {
          reason_codes: result.reasonCodes,
        },
      },
    };
  };
}

export function createVeoVideoStageHandler(options: VeoVideoStageOptions): StageHandler {
  const generator = createVeoVideoGenerator({
    client: options.client,
    model: options.model,
    clock: options.clock,
  });

  return async (context) => {
    const result = await generator.generate(context.payload, context.runId, context.attemptCount);

    if (result.outcome === "ok") {
      return {
        type: "success",
        data: result.stageData,
        providerRef: result.providerRef ?? undefined,
      };
    }

    if (result.outcome === "policy_blocked" || result.outcome === "needs_clarification") {
      return {
        type: "terminal_outcome",
        outcome: result.outcome,
        reason: `${result.reason} (${result.reasonCodes.join(",")})`,
        data: {
          video_generation: {
            reason_codes: result.reasonCodes,
          },
        },
      };
    }

    if (result.outcome === "retryable_error") {
      return {
        type: "retryable_error",
        reason: result.reason,
        providerRef: result.providerRef ?? undefined,
        details: result.details,
      };
    }

    if (result.outcome === "provider_failed") {
      return {
        type: "fatal_error",
        reason: result.reason,
        providerRef: result.providerRef ?? undefined,
        details: result.details,
      };
    }

    return {
      type: "fatal_error",
      reason: "unexpected veo stage result",
    };
  };
}

export function createSubtitlesExportStageHandler(options: SubtitlesExportStageOptions): StageHandler {
  const generator = createSubtitlesExportGenerator({
    artifactsRootDir: options.artifactsRootDir,
    tempRootDir: options.tempRootDir,
    fixtureMode: options.fixtureMode,
    commandRunner: options.commandRunner,
    routeSigningSecret: options.routeSigningSecret,
    now: options.now,
  });

  return async (context) => {
    const result = await generator.generate(context.payload, context.runId);

    if (result.outcome === "ok") {
      return {
        type: "success",
        data: result.stageData,
      };
    }

    if (result.outcome === "needs_clarification") {
      return {
        type: "terminal_outcome",
        outcome: "needs_clarification",
        reason: result.reason,
      };
    }

    return {
      type: "fatal_error",
      reason: result.reason,
    };
  };
}

export function createStageHandlers(options: StageHandlerFactoryOptions = {}): StageHandlers {
  const normalizeStage = options.normalize ?? runMockStage;
  const validatePolicyStage = options.validatePolicy ?? runMockStage;
  const imageGenerationStage = options.imageGeneration ?? runMockStage;
  const videoGenerationStage = options.videoGeneration ?? runMockStage;
  const subtitlesExportStage = options.subtitlesExport ?? runMockStage;

  return {
    normalize: normalizeStage,
    validate_policy: validatePolicyStage,
    image_generation: imageGenerationStage,
    video_generation: videoGenerationStage,
    subtitles_export: subtitlesExportStage,
  };
}

export function createMockStageHandlers(): StageHandlers {
  return createStageHandlers();
}
