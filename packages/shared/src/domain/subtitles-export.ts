import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseNormalizedBrief } from "./brief-schema";
import {
  GEMINI_FLASH_IMAGE_PROMPT_ID,
  getPromptRegistryEntry,
  NORMALIZE_BRIEF_PROMPT_ID,
  VEO_IMAGE_TO_VIDEO_PROMPT_ID,
} from "./prompt-registry";

const SUBTITLES_EXPORT_PROMPT_ID = "render_scene_copy_subtitles_v1" as const;
const SUBTITLES_EXPORT_PROMPT_VERSION = 1 as const;
const SUBTITLES_EXPORT_TEMPLATE_HASH = "fd6f51d8263bf9066f5d6930352e05f8f328b466b5d11fd58519857c0faeab4f";

const EXPORT_WIDTH = 1280;
const EXPORT_HEIGHT = 720;
const EXPORT_FPS = 24;
const EXPORT_CODEC = "h264";
const EXPORT_MAX_DURATION_SECONDS = 30;
const SIGNED_ROUTE_TTL_SECONDS = 24 * 60 * 60;
const MAX_SUBTITLE_LINE_CHARS = 42;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toLocalPath(storagePath: string): string | null {
  if (storagePath.startsWith("file://")) {
    return new URL(storagePath).pathname;
  }

  if (path.isAbsolute(storagePath)) {
    return storagePath;
  }

  return null;
}

function parseFps(value: string | undefined): number | null {
  if (!value || !value.includes("/")) {
    return null;
  }

  const [numeratorRaw, denominatorRaw] = value.split("/");
  const numerator = Number.parseFloat(numeratorRaw ?? "0");
  const denominator = Number.parseFloat(denominatorRaw ?? "1");
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }

  return numerator / denominator;
}

function formatSrtTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = Math.floor(clamped % 60);
  const milliseconds = Math.floor((clamped - Math.floor(clamped)) * 1000);

  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  const mmm = String(milliseconds).padStart(3, "0");
  return `${hh}:${mm}:${ss},${mmm}`;
}

function normalizeSubtitleText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function wrapSubtitleText(input: string): string[] {
  const text = normalizeSubtitleText(input);
  if (!text) {
    return [""];
  }

  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= MAX_SUBTITLE_LINE_CHARS) {
      current = candidate;
      continue;
    }

    if (current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      lines.push(word.slice(0, MAX_SUBTITLE_LINE_CHARS));
      current = word.slice(MAX_SUBTITLE_LINE_CHARS);
    }

    if (lines.length === 2) {
      break;
    }
  }

  if (lines.length < 2 && current.length > 0) {
    lines.push(current);
  }

  if (lines.length > 2) {
    const truncated = lines.slice(0, 2);
    const second = truncated[1] ?? "";
    truncated[1] = second.length >= MAX_SUBTITLE_LINE_CHARS - 1
      ? `${second.slice(0, MAX_SUBTITLE_LINE_CHARS - 1)}…`
      : `${second}…`;
    return truncated;
  }

  return lines.slice(0, 2);
}

function escapeForConcatList(filePath: string): string {
  return filePath.replace(/'/g, "'\\''");
}

function escapeForSubtitleFilter(filePath: string): string {
  return filePath
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/'/g, "\\'");
}

async function hashFileSha256(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type MediaCommandRunner = (command: "ffprobe" | "ffmpeg", args: string[]) => Promise<CommandResult>;

function createDefaultMediaCommandRunner(): MediaCommandRunner {
  return async (command, args) => {
    return await new Promise((resolve) => {
      const child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (error) => {
        resolve({
          exitCode: 1,
          stdout,
          stderr: `${stderr}${error.message}`,
        });
      });
      child.on("close", (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
        });
      });
    });
  };
}

type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
};

type ProbeResult = {
  streams?: ProbeStream[];
  format?: {
    duration?: string;
  };
};

type ClipInput = {
  scene_id: string;
  clip_id: string;
  storage_path: string;
  sha256: string;
  source_asset_ids: string[];
};

type ValidatedClip = {
  scene_id: string;
  clip_id: string;
  file_path: string;
  duration_seconds: number;
  sha256: string;
  source_asset_ids: string[];
};

function readVideoGenerationClips(payload: unknown): ClipInput[] {
  if (!isRecord(payload) || !isRecord(payload.stage_outputs)) {
    return [];
  }

  const videoStage = payload.stage_outputs.video_generation;
  if (!isRecord(videoStage) || !isRecord(videoStage.video_generation)) {
    return [];
  }

  const derivedScenes = videoStage.video_generation.derived_video_scenes;
  if (!Array.isArray(derivedScenes)) {
    return [];
  }

  const clips: ClipInput[] = [];
  for (const scene of derivedScenes) {
    if (!isRecord(scene) || !isRecord(scene.clip)) {
      continue;
    }

    const clipId = typeof scene.clip.clip_id === "string" ? scene.clip.clip_id : null;
    const storagePath = typeof scene.clip.storage_path === "string" ? scene.clip.storage_path : null;
    const sceneId = typeof scene.scene_id === "string" ? scene.scene_id : null;
    const sha = typeof scene.clip.sha256 === "string" ? scene.clip.sha256 : "";
    const sourceAssetIds = Array.isArray(scene.source_asset_ids)
      ? scene.source_asset_ids.filter((entry): entry is string => typeof entry === "string")
      : [];

    if (!clipId || !storagePath || !sceneId) {
      continue;
    }

    clips.push({
      scene_id: sceneId,
      clip_id: clipId,
      storage_path: storagePath,
      sha256: sha,
      source_asset_ids: sourceAssetIds,
    });
  }

  return clips;
}

function getPromptMetadataForProvenance(payload: unknown): Record<string, unknown> {
  const normalizePrompt = getPromptRegistryEntry(NORMALIZE_BRIEF_PROMPT_ID);
  const imagePrompt = getPromptRegistryEntry(GEMINI_FLASH_IMAGE_PROMPT_ID);
  const videoPrompt = getPromptRegistryEntry(VEO_IMAGE_TO_VIDEO_PROMPT_ID);

  const toPrompt = (value: { prompt_id: string; version: number; template_hash: string }) => {
    return {
      prompt_id: value.prompt_id,
      version: value.version,
      template_hash: value.template_hash,
    };
  };

  const stageOutputs = isRecord(payload) && isRecord(payload.stage_outputs)
    ? payload.stage_outputs
    : null;

  const normalizeMetadata =
    stageOutputs && isRecord(stageOutputs.normalize) && isRecord(stageOutputs.normalize.normalize)
      ? stageOutputs.normalize.normalize.prompt_metadata
      : null;
  const imageMetadata =
    stageOutputs && isRecord(stageOutputs.image_generation) && isRecord(stageOutputs.image_generation.image_generation)
      ? stageOutputs.image_generation.image_generation.prompt_metadata
      : null;
  const videoMetadata =
    stageOutputs && isRecord(stageOutputs.video_generation) && isRecord(stageOutputs.video_generation.video_generation)
      ? stageOutputs.video_generation.video_generation.prompt_metadata
      : null;

  return {
    normalize: normalizeMetadata ?? toPrompt(normalizePrompt),
    image_generation: imageMetadata ?? toPrompt(imagePrompt),
    video_generation: videoMetadata ?? toPrompt(videoPrompt),
    subtitles_export: {
      prompt_id: SUBTITLES_EXPORT_PROMPT_ID,
      version: SUBTITLES_EXPORT_PROMPT_VERSION,
      template_hash: SUBTITLES_EXPORT_TEMPLATE_HASH,
    },
  };
}

type SignedRouteMetadata = {
  route_path: string;
  signed_path: string;
  expires_at: string;
  ttl_seconds: number;
};

function buildSignedRoute(
  runId: string,
  artifactName: string,
  now: Date,
  signingSecret: string,
): SignedRouteMetadata {
  const expiresAt = new Date(now.getTime() + SIGNED_ROUTE_TTL_SECONDS * 1000).toISOString();
  const routePath = `/api/v1/runs/${runId}/artifacts/${artifactName}`;
  const signature = crypto
    .createHmac("sha256", signingSecret)
    .update(`${runId}:${artifactName}:${expiresAt}`)
    .digest("hex");

  return {
    route_path: routePath,
    signed_path: `${routePath}?expires=${encodeURIComponent(expiresAt)}&signature=${signature}`,
    expires_at: expiresAt,
    ttl_seconds: SIGNED_ROUTE_TTL_SECONDS,
  };
}

function collectSourceAssetIds(payload: unknown, fallbackSceneAssetIds: string[]): string[] {
  const unique = new Set<string>(fallbackSceneAssetIds);

  if (isRecord(payload) && isRecord(payload.stage_outputs)) {
    const imageStage = payload.stage_outputs.image_generation;
    if (isRecord(imageStage) && isRecord(imageStage.image_generation)) {
      const ids = imageStage.image_generation.source_asset_ids;
      if (Array.isArray(ids)) {
        for (const id of ids) {
          if (typeof id === "string") {
            unique.add(id);
          }
        }
      }
    }
  }

  return [...unique].sort();
}

function collectProviderIds(payload: unknown): {
  image_generation_job_refs: string[];
  video_generation_job_refs: string[];
} {
  const imageRefs = new Set<string>();
  const videoRefs = new Set<string>();

  if (!isRecord(payload) || !isRecord(payload.stage_outputs)) {
    return {
      image_generation_job_refs: [],
      video_generation_job_refs: [],
    };
  }

  const imageStage = payload.stage_outputs.image_generation;
  if (isRecord(imageStage) && isRecord(imageStage.image_generation)) {
    const derivedStills = imageStage.image_generation.derived_stills;
    if (Array.isArray(derivedStills)) {
      for (const still of derivedStills) {
        if (isRecord(still) && typeof still.provider_job_reference === "string") {
          imageRefs.add(still.provider_job_reference);
        }
      }
    }
  }

  const videoStage = payload.stage_outputs.video_generation;
  if (isRecord(videoStage) && isRecord(videoStage.video_generation)) {
    const derivedScenes = videoStage.video_generation.derived_video_scenes;
    if (Array.isArray(derivedScenes)) {
      for (const scene of derivedScenes) {
        if (isRecord(scene) && typeof scene.provider_job_reference === "string") {
          videoRefs.add(scene.provider_job_reference);
        }
      }
    }
  }

  return {
    image_generation_job_refs: [...imageRefs].sort(),
    video_generation_job_refs: [...videoRefs].sort(),
  };
}

async function probeMedia(
  commandRunner: MediaCommandRunner,
  inputPath: string,
): Promise<ProbeResult> {
  const probe = await commandRunner("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    inputPath,
  ]);

  if (probe.exitCode !== 0) {
    throw new Error(`ffprobe failed for ${inputPath}: ${probe.stderr || probe.stdout}`);
  }

  return JSON.parse(probe.stdout) as ProbeResult;
}

function getPrimaryVideoStream(probe: ProbeResult): ProbeStream | null {
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  return streams.find((stream) => stream.codec_type === "video") ?? null;
}

function readDurationSeconds(probe: ProbeResult, videoStream: ProbeStream): number {
  const streamDuration = Number.parseFloat(videoStream.duration ?? "");
  if (Number.isFinite(streamDuration) && streamDuration > 0) {
    return streamDuration;
  }

  const formatDuration = Number.parseFloat(probe.format?.duration ?? "");
  if (Number.isFinite(formatDuration) && formatDuration > 0) {
    return formatDuration;
  }

  return 0;
}

function isFixtureMode(payload: unknown, fallbackFixtureMode: boolean): boolean {
  if (isRecord(payload) && typeof payload.fixture_mode === "boolean") {
    return payload.fixture_mode;
  }

  return fallbackFixtureMode;
}

function buildSubtitleSrt(
  narratives: Array<{ duration_seconds: number; text: string }>,
): string {
  const lines: string[] = [];
  let cursor = 0;
  let sequence = 1;

  for (const item of narratives) {
    if (cursor >= EXPORT_MAX_DURATION_SECONDS) {
      break;
    }

    const duration = Math.max(0.4, Math.min(item.duration_seconds, EXPORT_MAX_DURATION_SECONDS - cursor));
    const end = Math.min(EXPORT_MAX_DURATION_SECONDS, cursor + duration);
    const wrapped = wrapSubtitleText(item.text);
    if (wrapped.join("").trim().length === 0) {
      cursor = end;
      continue;
    }

    lines.push(String(sequence));
    lines.push(`${formatSrtTimestamp(cursor)} --> ${formatSrtTimestamp(end)}`);
    lines.push(...wrapped);
    lines.push("");

    sequence += 1;
    cursor = end;
  }

  return `${lines.join("\n")}\n`;
}

export type SubtitlesExportGeneratorOptions = {
  artifactsRootDir: string;
  tempRootDir?: string;
  fixtureMode?: boolean;
  commandRunner?: MediaCommandRunner;
  routeSigningSecret?: string;
  now?: () => Date;
};

type SubtitlesExportGeneratorSuccess = {
  outcome: "ok";
  stageData: {
    subtitles_export: {
      export_spec: {
        width: 1280;
        height: 720;
        fps: 24;
        codec: "h264";
        container: "mp4";
        max_duration_seconds: 30;
        soundtrack: "none";
      };
      export_metadata: {
        duration_seconds: number;
        subtitle_entries: number;
        fixture_mode: boolean;
      };
      artifact_routes: {
        final_mp4: SignedRouteMetadata;
        provenance_json: SignedRouteMetadata;
      };
      checksums: {
        final_mp4_sha256: string;
        provenance_sha256: string;
      };
    };
  };
};

type SubtitlesExportGeneratorFailure = {
  outcome: "needs_clarification" | "provider_failed";
  reason: string;
};

export function createSubtitlesExportGenerator(options: SubtitlesExportGeneratorOptions): {
  generate: (payload: unknown, runId: string) => Promise<SubtitlesExportGeneratorSuccess | SubtitlesExportGeneratorFailure>;
} {
  const commandRunner = options.commandRunner ?? createDefaultMediaCommandRunner();
  const tempRootDir = options.tempRootDir ?? path.join(os.tmpdir(), "deal-pump-exports");
  const routeSigningSecret = options.routeSigningSecret ?? "dev-artifact-route-secret";
  const nowFn = options.now ?? (() => new Date());

  return {
    generate: async (payload, runId) => {
      const parsedBrief = parseNormalizedBrief(
        isRecord(payload) && "normalized_brief" in payload ? payload.normalized_brief : payload,
      );
      if (!parsedBrief.ok) {
        return {
          outcome: "needs_clarification",
          reason: "normalized brief schema validation failed before subtitles_export",
        };
      }

      const exportStartedAt = nowFn();
      const fixtureMode = isFixtureMode(payload, options.fixtureMode ?? false);
      const runTempDir = path.join(tempRootDir, runId, String(exportStartedAt.getTime()));
      const normalizedDir = path.join(runTempDir, "normalized");
      const artifactsRunDir = path.join(options.artifactsRootDir, "runs", runId);
      await fs.mkdir(normalizedDir, { recursive: true });
      await fs.mkdir(artifactsRunDir, { recursive: true });

      let clipInputs = readVideoGenerationClips(payload);
      if (clipInputs.length === 0 && !fixtureMode) {
        return {
          outcome: "provider_failed",
          reason: "subtitles_export requires video_generation clip metadata unless fixture mode is enabled",
        };
      }

      if (fixtureMode) {
        const fixtureInputs: ClipInput[] = [];
        for (const [index, scene] of parsedBrief.value.scenes.entries()) {
          const duration = Math.max(0.8, Math.min(scene.durationSeconds, EXPORT_MAX_DURATION_SECONDS));
          const fixtureClipPath = path.join(runTempDir, `fixture-scene-${index + 1}.mp4`);
          const fixtureResult = await commandRunner("ffmpeg", [
            "-y",
            "-f",
            "lavfi",
            "-i",
            `color=c=black:s=${EXPORT_WIDTH}x${EXPORT_HEIGHT}:r=${EXPORT_FPS}:d=${duration.toFixed(3)}`,
            "-an",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            fixtureClipPath,
          ]);
          if (fixtureResult.exitCode !== 0) {
            return {
              outcome: "provider_failed",
              reason: `fixture clip generation failed: ${fixtureResult.stderr || fixtureResult.stdout}`,
            };
          }

          fixtureInputs.push({
            scene_id: scene.sceneId,
            clip_id: `fixture-${scene.sceneId}`,
            storage_path: fixtureClipPath,
            sha256: "",
            source_asset_ids: [...scene.approvedAssetIds],
          });
        }

        if (fixtureInputs.length === 0) {
          const fixtureClipPath = path.join(runTempDir, "fixture-default.mp4");
          const fixtureResult = await commandRunner("ffmpeg", [
            "-y",
            "-f",
            "lavfi",
            "-i",
            `color=c=black:s=${EXPORT_WIDTH}x${EXPORT_HEIGHT}:r=${EXPORT_FPS}:d=2.0`,
            "-an",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            fixtureClipPath,
          ]);
          if (fixtureResult.exitCode !== 0) {
            return {
              outcome: "provider_failed",
              reason: `fixture clip generation failed: ${fixtureResult.stderr || fixtureResult.stdout}`,
            };
          }

          fixtureInputs.push({
            scene_id: "fixture-scene",
            clip_id: "fixture-scene",
            storage_path: fixtureClipPath,
            sha256: "",
            source_asset_ids: [],
          });
        }

        clipInputs = fixtureInputs;
      }

      const validatedClips: ValidatedClip[] = [];
      for (const clip of clipInputs) {
        const localPath = toLocalPath(clip.storage_path);
        if (!localPath) {
          return {
            outcome: "provider_failed",
            reason: `clip ${clip.clip_id} has unsupported storage_path '${clip.storage_path}' for export`,
          };
        }

        try {
          await fs.access(localPath);
        } catch {
          return {
            outcome: "provider_failed",
            reason: `clip file missing on disk before export: ${clip.clip_id}`,
          };
        }

        const probe = await probeMedia(commandRunner, localPath);
        const videoStream = getPrimaryVideoStream(probe);
        if (!videoStream) {
          return {
            outcome: "provider_failed",
            reason: `ffprobe validation failed: ${clip.clip_id} has no video stream`,
          };
        }

        const durationSeconds = readDurationSeconds(probe, videoStream);
        if (durationSeconds <= 0) {
          return {
            outcome: "provider_failed",
            reason: `ffprobe validation failed: ${clip.clip_id} has no positive duration`,
          };
        }

        validatedClips.push({
          scene_id: clip.scene_id,
          clip_id: clip.clip_id,
          file_path: localPath,
          duration_seconds: durationSeconds,
          sha256: clip.sha256,
          source_asset_ids: clip.source_asset_ids,
        });
      }

      if (validatedClips.length === 0) {
        return {
          outcome: "provider_failed",
          reason: "no validated clips were available for export",
        };
      }

      const normalizedPaths: string[] = [];
      let remainingDuration = EXPORT_MAX_DURATION_SECONDS;
      for (let index = 0; index < validatedClips.length; index += 1) {
        if (remainingDuration <= 0) {
          break;
        }

        const clip = validatedClips[index];
        const normalizedDuration = Math.min(clip.duration_seconds, remainingDuration);
        const normalizedPath = path.join(normalizedDir, `clip-${String(index + 1).padStart(2, "0")}.mp4`);
        const normalizeResult = await commandRunner("ffmpeg", [
          "-y",
          "-i",
          clip.file_path,
          "-an",
          "-vf",
          `scale=${EXPORT_WIDTH}:${EXPORT_HEIGHT}:force_original_aspect_ratio=decrease,pad=${EXPORT_WIDTH}:${EXPORT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,fps=${EXPORT_FPS},format=yuv420p,setsar=1`,
          "-c:v",
          "libx264",
          "-r",
          String(EXPORT_FPS),
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          "-t",
          normalizedDuration.toFixed(3),
          normalizedPath,
        ]);

        if (normalizeResult.exitCode !== 0) {
          return {
            outcome: "provider_failed",
            reason: `clip normalization failed for ${clip.clip_id}: ${normalizeResult.stderr || normalizeResult.stdout}`,
          };
        }

        normalizedPaths.push(normalizedPath);
        remainingDuration -= normalizedDuration;
      }

      if (normalizedPaths.length === 0) {
        return {
          outcome: "provider_failed",
          reason: "all clips were filtered out during normalization",
        };
      }

      const concatListPath = path.join(runTempDir, "concat-list.txt");
      const concatBody = normalizedPaths
        .map((filePath) => `file '${escapeForConcatList(filePath)}'`)
        .join("\n");
      await fs.writeFile(concatListPath, `${concatBody}\n`, "utf8");

      const assembledPath = path.join(runTempDir, "assembled.mp4");
      const concatResult = await commandRunner("ffmpeg", [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concatListPath,
        "-an",
        "-c:v",
        "libx264",
        "-r",
        String(EXPORT_FPS),
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        assembledPath,
      ]);

      if (concatResult.exitCode !== 0) {
        return {
          outcome: "provider_failed",
          reason: `clip concatenation failed: ${concatResult.stderr || concatResult.stdout}`,
        };
      }

      const subtitleEntries = parsedBrief.value.scenes.map((scene) => {
        return {
          duration_seconds: scene.durationSeconds,
          text: scene.narrative,
        };
      });
      const subtitlesPath = path.join(runTempDir, "subtitles.srt");
      await fs.writeFile(subtitlesPath, buildSubtitleSrt(subtitleEntries), "utf8");

      const finalVideoPath = path.join(artifactsRunDir, "final.mp4");
      const burnResult = await commandRunner("ffmpeg", [
        "-y",
        "-i",
        assembledPath,
        "-vf",
        `subtitles=${escapeForSubtitleFilter(subtitlesPath)}`,
        "-an",
        "-c:v",
        "libx264",
        "-r",
        String(EXPORT_FPS),
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        finalVideoPath,
      ]);

      if (burnResult.exitCode !== 0) {
        return {
          outcome: "provider_failed",
          reason: `subtitle burn-in failed: ${burnResult.stderr || burnResult.stdout}`,
        };
      }

      const finalProbe = await probeMedia(commandRunner, finalVideoPath);
      const finalVideoStream = getPrimaryVideoStream(finalProbe);
      if (!finalVideoStream) {
        return {
          outcome: "provider_failed",
          reason: "final mp4 validation failed: missing video stream",
        };
      }

      const finalWidth = finalVideoStream.width ?? 0;
      const finalHeight = finalVideoStream.height ?? 0;
      const fps = parseFps(finalVideoStream.avg_frame_rate ?? finalVideoStream.r_frame_rate);
      const codecName = finalVideoStream.codec_name ?? "";
      const duration = readDurationSeconds(finalProbe, finalVideoStream);
      const hasAudio = (finalProbe.streams ?? []).some((stream) => stream.codec_type === "audio");

      if (
        finalWidth !== EXPORT_WIDTH ||
        finalHeight !== EXPORT_HEIGHT ||
        !fps ||
        Math.abs(fps - EXPORT_FPS) > 0.2 ||
        codecName !== EXPORT_CODEC ||
        duration > EXPORT_MAX_DURATION_SECONDS + 0.1 ||
        hasAudio
      ) {
        return {
          outcome: "provider_failed",
          reason: "final mp4 failed locked export spec validation",
        };
      }

      const finalChecksum = await hashFileSha256(finalVideoPath);

      const normalizedBriefAssetIds = parsedBrief.value.scenes.flatMap((scene) => [...scene.approvedAssetIds]);
      const sourceAssetIds = collectSourceAssetIds(payload, normalizedBriefAssetIds);
      const providerIds = collectProviderIds(payload);

      const now = nowFn();
      const finalRoute = buildSignedRoute(runId, "final.mp4", now, routeSigningSecret);
      const provenanceRoute = buildSignedRoute(runId, "provenance.json", now, routeSigningSecret);

      const stageTimestamps: Record<string, unknown> = {
        normalize: null,
        validate_policy: null,
        image_generation: null,
        video_generation: null,
        subtitles_export: {
          started_at: exportStartedAt.toISOString(),
          completed_at: now.toISOString(),
        },
      };

      const sourceClipChecksums = await Promise.all(
        validatedClips.map(async (clip) => {
          return {
            scene_id: clip.scene_id,
            clip_id: clip.clip_id,
            sha256: await hashFileSha256(clip.file_path),
          };
        }),
      );

      const provenance = {
        run_id: runId,
        generated_at: now.toISOString(),
        source_assets: sourceAssetIds,
        prompt_registry: getPromptMetadataForProvenance(payload),
        provider_ids: providerIds,
        stage_timestamps: stageTimestamps,
        checksums: {
          final_mp4_sha256: finalChecksum,
          source_clips: sourceClipChecksums,
        },
        signed_artifacts: {
          final_mp4: finalRoute,
          provenance_json: provenanceRoute,
        },
        export_metadata: {
          width: EXPORT_WIDTH,
          height: EXPORT_HEIGHT,
          fps: EXPORT_FPS,
          codec: EXPORT_CODEC,
          container: "mp4",
          max_duration_seconds: EXPORT_MAX_DURATION_SECONDS,
          soundtrack: "none",
          duration_seconds: Number(duration.toFixed(3)),
        },
      };

      const provenancePath = path.join(artifactsRunDir, "provenance.json");
      await fs.writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
      const provenanceChecksum = await hashFileSha256(provenancePath);

      const finalizedProvenance = {
        ...provenance,
        checksums: {
          ...provenance.checksums,
          provenance_sha256: provenanceChecksum,
        },
      };

      await fs.writeFile(provenancePath, `${JSON.stringify(finalizedProvenance, null, 2)}\n`, "utf8");

      return {
        outcome: "ok",
        stageData: {
          subtitles_export: {
            export_spec: {
              width: EXPORT_WIDTH,
              height: EXPORT_HEIGHT,
              fps: EXPORT_FPS,
              codec: EXPORT_CODEC,
              container: "mp4",
              max_duration_seconds: EXPORT_MAX_DURATION_SECONDS,
              soundtrack: "none",
            },
            export_metadata: {
              duration_seconds: Number(duration.toFixed(3)),
              subtitle_entries: subtitleEntries.length,
              fixture_mode: fixtureMode,
            },
            artifact_routes: {
              final_mp4: finalRoute,
              provenance_json: provenanceRoute,
            },
            checksums: {
              final_mp4_sha256: finalChecksum,
              provenance_sha256: provenanceChecksum,
            },
          },
        },
      };
    },
  };
}
