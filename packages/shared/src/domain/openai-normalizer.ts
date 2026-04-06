import {
  BRIEF_SCHEMA_VERSION,
  parseNormalizedBrief,
  type NormalizedBrief,
} from "./brief-schema";
import type { FailureReasonCode } from "./contracts";
import {
  getPromptRegistryEntry,
  NORMALIZE_BRIEF_PROMPT_ID,
  REPAIR_BRIEF_PROMPT_ID,
  type PromptRegistryEntry,
} from "./prompt-registry";

const DEFAULT_MODEL = "gpt-5.4-mini";
const DEFAULT_MAX_INPUT_CHARS = 4_000;
const MAX_SCENE_DURATION_SECONDS = 10;
const MAX_TOTAL_DURATION_SECONDS = 10;
const SUPPORTED_VEO_SCENE_DURATIONS = [4, 6, 8] as const;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

type ResponseInputMessage = {
  role: "system" | "user";
  content: string;
};

export type OpenAIResponsesRequest = {
  model: string;
  input: ResponseInputMessage[];
};

export type OpenAIResponsesResult = {
  id?: string;
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
};

export interface OpenAIResponsesClient {
  createResponse: (request: OpenAIResponsesRequest) => Promise<OpenAIResponsesResult>;
}

type OpenAIResponsesRuntimeClient = {
  responses: {
    create: (request: unknown) => Promise<unknown>;
  };
};

type OpenAIResponsesRuntimeClientConstructor = new (options: {
  apiKey: string;
  timeout?: number;
  maxRetries?: number;
  organization?: string;
  project?: string;
}) => OpenAIResponsesRuntimeClient;

type OpenAIModule = {
  default: OpenAIResponsesRuntimeClientConstructor;
};

const loadOpenAIModule = new Function("return import('openai')") as () => Promise<OpenAIModule>;

export type OpenAIResponsesSdkClientOptions = {
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
  organization?: string;
  project?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function parseOpenAIResponsesResult(payload: unknown): OpenAIResponsesResult {
  if (!isRecord(payload)) {
    return {};
  }

  const id = readStringField(payload, "id") ?? readStringField(payload, "_request_id");
  const outputText = readStringField(payload, "output_text");
  const outputValue = payload.output;
  const output = Array.isArray(outputValue)
    ? outputValue
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .map((entry) => {
          const contentValue = entry.content;
          const content = Array.isArray(contentValue)
            ? contentValue
                .filter((part): part is Record<string, unknown> => isRecord(part))
                .map((part) => {
                  return {
                    type: readStringField(part, "type"),
                    text: readStringField(part, "text"),
                  };
                })
            : [];

          return { content };
        })
    : undefined;

  return {
    id,
    output_text: outputText,
    output,
  };
}

export function createOpenAIResponsesSdkClient(
  options: OpenAIResponsesSdkClientOptions,
): OpenAIResponsesClient {
  let clientPromise: Promise<OpenAIResponsesRuntimeClient> | null = null;

  async function getClient(): Promise<OpenAIResponsesRuntimeClient> {
    if (!clientPromise) {
      clientPromise = (async () => {
        const openaiSdk = await loadOpenAIModule();
        return new openaiSdk.default({
          apiKey: options.apiKey,
          timeout: options.timeoutMs,
          maxRetries: options.maxRetries,
          organization: options.organization,
          project: options.project,
        });
      })();
    }

    return await clientPromise;
  }

  return {
    createResponse: async (request) => {
      const client = await getClient();
      const response = await client.responses.create({
        model: request.model,
        input: request.input,
      });

      return parseOpenAIResponsesResult(response);
    },
  };
}

export type PromptMetadata = {
  prompt_id: PromptRegistryEntry["prompt_id"];
  version: PromptRegistryEntry["version"];
  template_hash: PromptRegistryEntry["template_hash"];
  model: string;
};

type SharedResult = {
  sanitizedBrief: string;
  promptMetadata: PromptMetadata[];
  repairAttempted: boolean;
};

export type NormalizeBriefResult =
  | (SharedResult & {
      outcome: "ok";
      normalizedBrief: NormalizedBrief;
      providerRef: string | null;
    })
  | (SharedResult & {
      outcome: "needs_clarification";
      reasonCodes: FailureReasonCode[];
      providerRef: string | null;
    })
  | (SharedResult & {
      outcome: "provider_failed";
      reason: string;
      providerRef: string | null;
    });

export type OpenAINormalizerOptions = {
  client: OpenAIResponsesClient;
  model?: string;
  maxInputChars?: number;
};

function sanitizeBrief(value: string, maxInputChars: number): string {
  const withoutControls = value.replace(CONTROL_CHARACTERS, "");
  const trimmed = withoutControls.trim();
  if (trimmed.length <= maxInputChars) {
    return trimmed;
  }

  return trimmed.slice(0, maxInputChars);
}

function renderPromptTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key: string) => {
    return variables[key] ?? "";
  });
}

function extractOutputText(response: OpenAIResponsesResult): string | null {
  if (typeof response.output_text === "string" && response.output_text.trim().length > 0) {
    return response.output_text;
  }

  for (const outputPart of response.output ?? []) {
    for (const content of outputPart.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string" && content.text.trim().length > 0) {
        return content.text;
      }
    }
  }

  return null;
}

function parseModelJson(candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function containsModelSelectedAssetIds(brief: NormalizedBrief): boolean {
  return brief.scenes.some((scene) => scene.approvedAssetIds.length > 0);
}

function metadataFromPrompt(prompt: PromptRegistryEntry, model: string): PromptMetadata {
  return {
    prompt_id: prompt.prompt_id,
    version: prompt.version,
    template_hash: prompt.template_hash,
    model,
  };
}

function clampBriefDurations(brief: NormalizedBrief): NormalizedBrief {
  let remainingDuration = MAX_TOTAL_DURATION_SECONDS;
  const scenes: Array<NormalizedBrief["scenes"][number]> = [];

  for (const scene of brief.scenes) {
    if (remainingDuration < 4) {
      break;
    }

    const nextDuration = chooseSupportedSceneDuration(scene.durationSeconds, remainingDuration);
    if (nextDuration === null) {
      break;
    }

    scenes.push({
      ...scene,
      durationSeconds: nextDuration,
    });
    remainingDuration -= nextDuration;
  }

  return {
    ...brief,
    scenes,
  };
}

function chooseSupportedSceneDuration(requestedDuration: number, remainingDuration: number): 4 | 6 | 8 | null {
  const boundedRequestedDuration = Math.max(
    1,
    Math.min(MAX_SCENE_DURATION_SECONDS, Math.round(requestedDuration)),
  );
  const supportedCandidates = SUPPORTED_VEO_SCENE_DURATIONS.filter(
    (duration) => duration <= remainingDuration,
  );

  if (supportedCandidates.length === 0) {
    return null;
  }

  return supportedCandidates.reduce((bestDuration, candidate) => {
    const bestDistance = Math.abs(bestDuration - boundedRequestedDuration);
    const candidateDistance = Math.abs(candidate - boundedRequestedDuration);

    if (candidateDistance < bestDistance) {
      return candidate;
    }

    if (candidateDistance === bestDistance) {
      return Math.min(bestDuration, candidate) as 4 | 6 | 8;
    }

    return bestDuration;
  });
}

function reasonCodesFromCandidate(candidate: string): FailureReasonCode[] {
  const parsedCandidate = parseModelJson(candidate);
  if (parsedCandidate === null) {
    return ["brief_invalid_schema"];
  }

  const parsed = parseNormalizedBrief(parsedCandidate);
  if (!parsed.ok) {
    return parsed.reasonCodes;
  }

  if (containsModelSelectedAssetIds(parsed.value)) {
    return ["brief_invalid_schema"];
  }

  return [];
}

function parseUserBrief(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }

  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (typeof record.brief === "string") {
      return record.brief;
    }

    if (typeof record.user_brief === "string") {
      return record.user_brief;
    }

    return JSON.stringify(payload);
  }

  return String(payload ?? "");
}

export function createOpenAINormalizer(options: OpenAINormalizerOptions): {
  normalize: (payload: unknown) => Promise<NormalizeBriefResult>;
} {
  const model = options.model ?? DEFAULT_MODEL;
  const maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;

  const normalizePrompt = getPromptRegistryEntry(NORMALIZE_BRIEF_PROMPT_ID);
  const repairPrompt = getPromptRegistryEntry(REPAIR_BRIEF_PROMPT_ID);

  return {
    normalize: async (payload) => {
      const rawBrief = parseUserBrief(payload);
      const sanitizedBrief = sanitizeBrief(rawBrief, maxInputChars);
      const normalizeMetadata = metadataFromPrompt(normalizePrompt, model);
      const repairMetadata = metadataFromPrompt(repairPrompt, model);
      let providerRef: string | null = null;

      try {
        const initialResponse = await options.client.createResponse({
          model,
          input: [
            {
              role: "system",
              content: renderPromptTemplate(normalizePrompt.template, {
                schema_version: BRIEF_SCHEMA_VERSION,
              }),
            },
            {
              role: "user",
              content: `UNTRUSTED_BRIEF_CONTENT_START\n${sanitizedBrief}\nUNTRUSTED_BRIEF_CONTENT_END`,
            },
          ],
        });
        providerRef = initialResponse.id ?? null;

        const initialText = extractOutputText(initialResponse) ?? "";
        const initialCandidate = parseModelJson(initialText);
        const initialParsed = parseNormalizedBrief(initialCandidate);
        if (initialParsed.ok && !containsModelSelectedAssetIds(initialParsed.value)) {
          const clampedBrief = clampBriefDurations(initialParsed.value);
          return {
            outcome: "ok",
            normalizedBrief: clampedBrief,
            promptMetadata: [normalizeMetadata],
            providerRef,
            sanitizedBrief,
            repairAttempted: false,
          };
        }

        const reasonCodes = reasonCodesFromCandidate(initialText);
        const repairResponse = await options.client.createResponse({
          model,
          input: [
            {
              role: "system",
              content: renderPromptTemplate(repairPrompt.template, {
                schema_version: BRIEF_SCHEMA_VERSION,
                reason_codes: reasonCodes.join(",") || "brief_invalid_schema",
                candidate_json: initialText || "{}",
              }),
            },
            {
              role: "user",
              content: `UNTRUSTED_BRIEF_CONTENT_START\n${sanitizedBrief}\nUNTRUSTED_BRIEF_CONTENT_END`,
            },
          ],
        });
        providerRef = repairResponse.id ?? providerRef;

        const repairedText = extractOutputText(repairResponse) ?? "";
        const repairedCandidate = parseModelJson(repairedText);
        const repairedParsed = parseNormalizedBrief(repairedCandidate);
        if (repairedParsed.ok && !containsModelSelectedAssetIds(repairedParsed.value)) {
          const clampedBrief = clampBriefDurations(repairedParsed.value);
          return {
            outcome: "ok",
            normalizedBrief: clampedBrief,
            promptMetadata: [normalizeMetadata, repairMetadata],
            providerRef,
            sanitizedBrief,
            repairAttempted: true,
          };
        }

        return {
          outcome: "needs_clarification",
          reasonCodes: reasonCodesFromCandidate(repairedText),
          promptMetadata: [normalizeMetadata, repairMetadata],
          providerRef,
          sanitizedBrief,
          repairAttempted: true,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "openai normalization call failed";
        return {
          outcome: "provider_failed",
          reason: message,
          promptMetadata: [normalizeMetadata],
          providerRef,
          sanitizedBrief,
          repairAttempted: false,
        };
      }
    },
  };
}
