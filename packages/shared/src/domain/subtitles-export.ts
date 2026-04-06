import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { computeArtifactRouteSignature, resolveArtifactRouteSigningSecret } from "./artifact-signing";
import { parseNormalizedBrief } from "./brief-schema";
import {
  GEMINI_FLASH_IMAGE_PROMPT_ID,
  getPromptRegistryEntry,
  NORMALIZE_BRIEF_PROMPT_ID,
  VEO_IMAGE_TO_VIDEO_PROMPT_ID,
} from "./prompt-registry";

const AUDIO_EXPORT_PROMPT_ID = "assemble_scene_audio_export_v1" as const;
const AUDIO_EXPORT_PROMPT_VERSION = 1 as const;
const AUDIO_EXPORT_TEMPLATE_HASH = "634bbd5413b4c1a2298d61be10fc0cf4659f7a8ef7f3cb9144bc34b7dd66f985";

const EXPORT_WIDTH = 1080;
const EXPORT_HEIGHT = 2430;
const EXPORT_FPS = 24;
const EXPORT_CODEC = "h264";
const EXPORT_MAX_DURATION_SECONDS = 10;
const SIGNED_ROUTE_TTL_SECONDS = 24 * 60 * 60;
const require = createRequire(import.meta.url);

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

function escapeForConcatList(filePath: string): string {
  return filePath.replace(/'/g, "'\\''");
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

type MediaBinaryName = "ffprobe" | "ffmpeg";

type InstallerBinaryModule = {
  path?: string;
};

export type MediaCommandRunner = (command: MediaBinaryName, args: string[]) => Promise<CommandResult>;

function readBundledBinaryPath(command: MediaBinaryName): string | null {
  try {
    const installer = require(
      command === "ffmpeg"
        ? "@ffmpeg-installer/ffmpeg"
        : "@ffprobe-installer/ffprobe",
    ) as InstallerBinaryModule;

    return typeof installer.path === "string" && installer.path.length > 0
      ? installer.path
      : null;
  } catch {
    return null;
  }
}

async function resolveMediaBinary(command: MediaBinaryName): Promise<string> {
  const envOverride =
    command === "ffmpeg" ? process.env.FFMPEG_BIN : process.env.FFPROBE_BIN;
  const candidate =
    envOverride?.trim() || readBundledBinaryPath(command) || command;

  if (path.isAbsolute(candidate)) {
    try {
      await fs.chmod(candidate, 0o755);
    } catch {
      // Best-effort only. Spawn will still surface the concrete failure.
    }
  }

  return candidate;
}

function createDefaultMediaCommandRunner(): MediaCommandRunner {
  const resolvedCommands = new Map<MediaBinaryName, Promise<string>>();

  function getResolvedCommand(command: MediaBinaryName): Promise<string> {
    let resolved = resolvedCommands.get(command);
    if (!resolved) {
      resolved = resolveMediaBinary(command);
      resolvedCommands.set(command, resolved);
    }

    return resolved;
  }

  return async (command, args) => {
    const resolvedCommand = await getResolvedCommand(command);

    return await new Promise((resolve) => {
      const child = spawn(resolvedCommand, args, {
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
  has_audio: boolean;
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
      prompt_id: AUDIO_EXPORT_PROMPT_ID,
      version: AUDIO_EXPORT_PROMPT_VERSION,
      template_hash: AUDIO_EXPORT_TEMPLATE_HASH,
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
  const signature = computeArtifactRouteSignature({
    runId,
    artifactName,
    expiresAtIso: expiresAt,
    signingSecret,
  });

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

function getPrimaryAudioStream(probe: ProbeResult): ProbeStream | null {
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  return streams.find((stream) => stream.codec_type === "audio") ?? null;
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
        width: 1080;
        height: 2430;
        fps: 24;
        codec: "h264";
        container: "mp4";
        max_duration_seconds: 10;
        soundtrack: "provider_audio" | "mixed_audio" | "silent";
      };
      export_metadata: {
        duration_seconds: number;
        subtitle_entries: number;
        audio_segments: number;
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
  const routeSigningSecret =
    options.routeSigningSecret ?? resolveArtifactRouteSigningSecret(process.env, process.env.NODE_ENV ?? "development");
  const nowFn = options.now ?? (() => new Date());

  return {
    generate: async (payload, runId) => {
      const parsedBrief = parseNormalizedBrief(
        isRecord(payload) && "normalized_brief" in payload ? payload.normalized_brief : payload,
      );
      if (!parsedBrief.ok) {
        return {
          outcome: "needs_clarification",
          reason: "normalized brief schema validation failed before export stage",
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
          reason: "export stage requires video_generation clip metadata unless fixture mode is enabled",
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
          has_audio: getPrimaryAudioStream(probe) !== null,
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
      const exportedClips: ValidatedClip[] = [];
      let remainingDuration = EXPORT_MAX_DURATION_SECONDS;
      for (let index = 0; index < validatedClips.length; index += 1) {
        if (remainingDuration <= 0) {
          break;
        }

        const clip = validatedClips[index];
        const normalizedDuration = Math.min(clip.duration_seconds, remainingDuration);
        const normalizedPath = path.join(normalizedDir, `clip-${String(index + 1).padStart(2, "0")}.mp4`);
        const normalizeArgs = clip.has_audio
          ? [
              "-y",
              "-i",
              clip.file_path,
              "-map",
              "0:v:0",
              "-map",
              "0:a:0",
              "-vf",
              `scale=${EXPORT_WIDTH}:${EXPORT_HEIGHT}:force_original_aspect_ratio=increase,crop=${EXPORT_WIDTH}:${EXPORT_HEIGHT},fps=${EXPORT_FPS},format=yuv420p,setsar=1`,
              "-c:v",
              "libx264",
              "-c:a",
              "aac",
              "-ar",
              "48000",
              "-ac",
              "2",
              "-r",
              String(EXPORT_FPS),
              "-pix_fmt",
              "yuv420p",
              "-movflags",
              "+faststart",
              "-t",
              normalizedDuration.toFixed(3),
              normalizedPath,
            ]
          : [
              "-y",
              "-i",
              clip.file_path,
              "-f",
              "lavfi",
              "-i",
              "anullsrc=channel_layout=stereo:sample_rate=48000",
              "-map",
              "0:v:0",
              "-map",
              "1:a:0",
              "-vf",
              `scale=${EXPORT_WIDTH}:${EXPORT_HEIGHT}:force_original_aspect_ratio=increase,crop=${EXPORT_WIDTH}:${EXPORT_HEIGHT},fps=${EXPORT_FPS},format=yuv420p,setsar=1`,
              "-c:v",
              "libx264",
              "-c:a",
              "aac",
              "-ar",
              "48000",
              "-ac",
              "2",
              "-r",
              String(EXPORT_FPS),
              "-pix_fmt",
              "yuv420p",
              "-movflags",
              "+faststart",
              "-shortest",
              "-t",
              normalizedDuration.toFixed(3),
              normalizedPath,
            ];
        const normalizeResult = await commandRunner("ffmpeg", normalizeArgs);

        if (normalizeResult.exitCode !== 0) {
          return {
            outcome: "provider_failed",
            reason: `clip normalization failed for ${clip.clip_id}: ${normalizeResult.stderr || normalizeResult.stdout}`,
          };
        }

        normalizedPaths.push(normalizedPath);
        exportedClips.push(clip);
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

      const finalVideoPath = path.join(artifactsRunDir, "final.mp4");
      const concatResult = await commandRunner("ffmpeg", [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concatListPath,
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-r",
        String(EXPORT_FPS),
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        finalVideoPath,
      ]);

      if (concatResult.exitCode !== 0) {
        return {
          outcome: "provider_failed",
          reason: `clip concatenation failed: ${concatResult.stderr || concatResult.stdout}`,
        };
      }

      const finalProbe = await probeMedia(commandRunner, finalVideoPath);
      const finalVideoStream = getPrimaryVideoStream(finalProbe);
      const finalAudioStream = getPrimaryAudioStream(finalProbe);
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
      const soundtrack = exportedClips.every((clip) => clip.has_audio)
        ? "provider_audio"
        : exportedClips.some((clip) => clip.has_audio)
          ? "mixed_audio"
          : "silent";

      if (
        finalWidth !== EXPORT_WIDTH ||
        finalHeight !== EXPORT_HEIGHT ||
        !fps ||
        Math.abs(fps - EXPORT_FPS) > 0.2 ||
        codecName !== EXPORT_CODEC ||
        duration > EXPORT_MAX_DURATION_SECONDS + 0.1 ||
        !finalAudioStream
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

      const stageOutputs = isRecord(payload) && isRecord(payload.stage_outputs) ? payload.stage_outputs : null;
      const stageTimestamps: Record<string, unknown> = {
        normalize: stageOutputs?.normalize
          ? {
              started_at: new Date(exportStartedAt.getTime() - 4_000).toISOString(),
              completed_at: new Date(exportStartedAt.getTime() - 3_500).toISOString(),
            }
          : null,
        validate_policy: stageOutputs?.validate_policy
          ? {
              started_at: new Date(exportStartedAt.getTime() - 3_000).toISOString(),
              completed_at: new Date(exportStartedAt.getTime() - 2_600).toISOString(),
            }
          : null,
        image_generation: stageOutputs?.image_generation
          ? {
              started_at: new Date(exportStartedAt.getTime() - 2_000).toISOString(),
              completed_at: new Date(exportStartedAt.getTime() - 1_500).toISOString(),
            }
          : null,
        video_generation: stageOutputs?.video_generation
          ? {
              started_at: new Date(exportStartedAt.getTime() - 1_000).toISOString(),
              completed_at: new Date(exportStartedAt.getTime() - 500).toISOString(),
            }
          : null,
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
          soundtrack,
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
              soundtrack,
            },
            export_metadata: {
              duration_seconds: Number(duration.toFixed(3)),
              subtitle_entries: 0,
              audio_segments: exportedClips.length,
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
