import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BRIEF_SCHEMA_VERSION,
  createSQLiteRunEngine,
  createStageHandlers,
  createSubtitlesExportStageHandler,
  type MediaCommandRunner,
  type StageHandler,
} from "@shared/index";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createNormalizedBrief() {
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    briefId: "brief-export-1",
    campaignName: "Export Integration",
    objective: "Assemble clips and preserve generated audio",
    language: "en" as const,
    aspectRatio: "16:9" as const,
    unresolvedQuestions: [],
    scenes: [
      {
        sceneId: "scene-intro",
        sceneType: "intro" as const,
        visualCriticality: "supporting" as const,
        narrative:
          "This opening line is intentionally long so audio-preserving export can be validated for deterministic output formatting in export tests.",
        desiredTags: ["logo", "background"] as const,
        approvedAssetIds: ["brand-wordmark-primary", "studio-gradient-backdrop"],
        generationMode: "asset_derived" as const,
        requestedTransform: "overlay" as const,
        durationSeconds: 5,
      },
      {
        sceneId: "scene-product",
        sceneType: "product_focus" as const,
        visualCriticality: "brand_critical" as const,
        narrative: "Product hero frame with controlled crop and no soundtrack.",
        desiredTags: ["product", "packshot"] as const,
        approvedAssetIds: ["product-can-classic-packshot"],
        generationMode: "asset_derived" as const,
        requestedTransform: "crop" as const,
        durationSeconds: 6,
      },
    ],
  };
}

function createMockMediaRunner(options?: {
  invalidProbePath?: string;
}): {
  calls: Array<{ command: "ffprobe" | "ffmpeg"; args: string[] }>;
  runner: MediaCommandRunner;
} {
  const calls: Array<{ command: "ffprobe" | "ffmpeg"; args: string[] }> = [];
  const metadataByPath = new Map<string, { width: number; height: number; codec: string; fps: number; duration: number; hasAudio: boolean }>();

  const runner: MediaCommandRunner = async (command, args) => {
    calls.push({ command, args: [...args] });
    const outputPath = args[args.length - 1] ?? "";

    if (command === "ffmpeg") {
      if (outputPath) {
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, Buffer.from(`video:${path.basename(outputPath)}`));

        const durationFromLavfi = args.find((value) => value.includes("color=") && value.includes(":d="));
        const durationMatch = durationFromLavfi?.match(/:d=([0-9.]+)/);
        const trimIndex = args.lastIndexOf("-t");
        const trimmedDuration =
          trimIndex >= 0 ? Number.parseFloat(args[trimIndex + 1] ?? "2") : Number.NaN;
        const duration = durationMatch
          ? Number.parseFloat(durationMatch[1] ?? "2")
          : Number.isFinite(trimmedDuration)
            ? trimmedDuration
            : 2;
        const hasAudio =
          !args.includes("-an") &&
          (args.includes("-c:a") ||
            args.some((value) => value.includes("anullsrc")) ||
            args.includes("0:a:0") ||
            args.includes("1:a:0"));
        metadataByPath.set(outputPath, {
          width: 1080,
          height: 2430,
          codec: "h264",
          fps: 24,
          duration: Number.isFinite(duration) ? duration : 2,
          hasAudio,
        });
      }

      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    }

    const inputPath = outputPath;
    if (options?.invalidProbePath && inputPath === options.invalidProbePath) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ streams: [], format: { duration: "0" } }),
        stderr: "",
      };
    }

    const metadata = metadataByPath.get(inputPath) ?? {
      width: 1080,
      height: 2430,
      codec: "h264",
      fps: 24,
      duration: 5,
      hasAudio: true,
    };

    const streams = [
      {
        codec_type: "video",
        codec_name: metadata.codec,
        width: metadata.width,
        height: metadata.height,
        avg_frame_rate: `${metadata.fps}/1`,
        duration: String(metadata.duration),
      },
    ] as Array<Record<string, unknown>>;

    if (metadata.hasAudio) {
      streams.push({
        codec_type: "audio",
        codec_name: "aac",
        duration: String(metadata.duration),
      });
    }

    return {
      exitCode: 0,
      stdout: JSON.stringify({ streams, format: { duration: String(metadata.duration) } }),
      stderr: "",
    };
  };

  return {
    calls,
    runner,
  };
}

describe("export", () => {
  test("subtitles_export validates clips, preserves audio, writes provenance, and stores signed routes", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deal-pump-export-"));
    const sqlitePath = path.join(tempRoot, "deal-pump.sqlite");
    const artifactsRoot = path.join(tempRoot, "artifacts");
    const clipOnePath = path.join(tempRoot, "scene-1.mp4");
    const clipTwoPath = path.join(tempRoot, "scene-2.mp4");
    await fs.writeFile(clipOnePath, "clip-one");
    await fs.writeFile(clipTwoPath, "clip-two");

    const normalizedBrief = createNormalizedBrief();
    const normalizeStage: StageHandler = async () => {
      return {
        type: "success",
        data: {
          normalize: {
            prompt_metadata: [],
            repair_attempted: false,
            sanitized_brief: "sanitized",
            normalized_brief: normalizedBrief,
            reason_codes: [],
          },
          normalized_brief: normalizedBrief,
        },
      };
    };
    const validatePolicyStage: StageHandler = async () => {
      return {
        type: "success",
        data: {
          validate_policy: {
            selected_asset_ids: [
              "brand-wordmark-primary",
              "studio-gradient-backdrop",
              "product-can-classic-packshot",
            ],
          },
          normalized_brief: normalizedBrief,
        },
      };
    };
    const imageStage: StageHandler = async () => {
      return {
        type: "success",
        data: {
          image_generation: {
            prompt_metadata: {
              prompt_id: "generate_scene_still_gemini_2_5_flash_image",
              version: 1,
              template_hash: "hash-image",
            },
            source_asset_ids: [
              "brand-wordmark-primary",
              "studio-gradient-backdrop",
              "product-can-classic-packshot",
            ],
            derived_stills: [],
          },
        },
      };
    };
    const videoStage: StageHandler = async () => {
      return {
        type: "success",
        data: {
          video_generation: {
            prompt_metadata: {
              prompt_id: "generate_scene_video_veo_3_1_i2v",
              version: 1,
              template_hash: "hash-video",
            },
            derived_video_scenes: [
              {
                scene_id: "scene-intro",
                source_asset_ids: ["brand-wordmark-primary", "studio-gradient-backdrop"],
                provider_job_reference: "vertex-veo-scene-intro",
                clip: {
                  clip_id: "clip-intro",
                  storage_path: clipOnePath,
                  sha256: "sha-clip-intro",
                },
              },
              {
                scene_id: "scene-product",
                source_asset_ids: ["product-can-classic-packshot"],
                provider_job_reference: "vertex-veo-scene-product",
                clip: {
                  clip_id: "clip-product",
                  storage_path: clipTwoPath,
                  sha256: "sha-clip-product",
                },
              },
            ],
          },
        },
      };
    };

    const mediaRunner = createMockMediaRunner();
    const subtitlesExport = createSubtitlesExportStageHandler({
      artifactsRootDir: artifactsRoot,
      tempRootDir: path.join(tempRoot, "tmp"),
      fixtureMode: false,
      commandRunner: mediaRunner.runner,
      routeSigningSecret: "route-secret",
      now: () => new Date("2026-04-02T10:00:00.000Z"),
    });

    const engine = await createSQLiteRunEngine({
      sqlitePath,
      leaseDurationMs: 250,
      retryBackoffBaseMs: 10,
    });
    await engine.initialize();

    const handlers = createStageHandlers({
      normalize: normalizeStage,
      validatePolicy: validatePolicyStage,
      imageGeneration: imageStage,
      videoGeneration: videoStage,
      subtitlesExport,
    });

    const started = await engine.startRun({
      idempotencyKey: "export-happy-path",
      payload: {
        brief: "export pipeline happy path",
      },
    });

    for (let index = 0; index < 160; index += 1) {
      const claim = await engine.claimNextJob();
      if (!claim) {
        await sleep(10);
        continue;
      }

      await engine.processClaim(claim, handlers);
      const projection = await engine.getRunProjection(started.runId);
      if (projection.phase === "completed") {
        break;
      }
    }

    const projection = await engine.getRunProjection(started.runId);
    expect(projection.phase).toBe("completed");
    expect(projection.outcome).toBe("ok");

    const exportResult = projection.result?.subtitles_export as {
      export_spec: { width: number; height: number; fps: number; codec: string; soundtrack: string };
      artifact_routes: {
        final_mp4: { ttl_seconds: number; route_path: string; signed_path: string };
        provenance_json: { ttl_seconds: number; route_path: string; signed_path: string };
      };
      checksums: {
        final_mp4_sha256: string;
        provenance_sha256: string;
      };
      export_metadata: {
        fixture_mode: boolean;
      };
    };

    expect(exportResult.export_spec).toEqual({
      width: 1080,
      height: 2430,
      fps: 24,
      codec: "h264",
      container: "mp4",
      max_duration_seconds: 10,
      soundtrack: "provider_audio",
    });
    expect(exportResult.export_metadata.fixture_mode).toBe(false);
    expect(exportResult.artifact_routes.final_mp4.ttl_seconds).toBe(24 * 60 * 60);
    expect(exportResult.artifact_routes.final_mp4.route_path).toMatch(
      new RegExp(`/api/v1/runs/${started.runId}/artifacts/final\\.mp4$`),
    );
    expect(exportResult.artifact_routes.final_mp4.signed_path).not.toContain(artifactsRoot);
    expect(exportResult.artifact_routes.provenance_json.signed_path).not.toContain(artifactsRoot);

    const finalVideoPath = path.join(artifactsRoot, "runs", started.runId, "final.mp4");
    const provenancePath = path.join(artifactsRoot, "runs", started.runId, "provenance.json");
    await expect(fs.stat(finalVideoPath)).resolves.toBeDefined();
    await expect(fs.stat(provenancePath)).resolves.toBeDefined();

    const provenance = JSON.parse(await fs.readFile(provenancePath, "utf8")) as {
      run_id: string;
      source_assets: string[];
      provider_ids: {
        image_generation_job_refs: string[];
        video_generation_job_refs: string[];
      };
      stage_timestamps: {
        subtitles_export: {
          started_at: string;
          completed_at: string;
        };
      };
      checksums: {
        provenance_sha256: string;
      };
      signed_artifacts: {
        final_mp4: {
          ttl_seconds: number;
          route_path: string;
          signed_path: string;
        };
      };
      export_metadata: {
        soundtrack: string;
      };
    };

    expect(provenance.run_id).toBe(started.runId);
    expect(provenance.source_assets).toEqual([
      "brand-wordmark-primary",
      "product-can-classic-packshot",
      "studio-gradient-backdrop",
    ]);
    expect(provenance.provider_ids.video_generation_job_refs).toEqual([
      "vertex-veo-scene-intro",
      "vertex-veo-scene-product",
    ]);
    expect(provenance.stage_timestamps.subtitles_export.started_at).toBeTruthy();
    expect(provenance.stage_timestamps.subtitles_export.completed_at).toBeTruthy();
    expect(provenance.checksums.provenance_sha256).toBe(exportResult.checksums.provenance_sha256);
    expect(provenance.signed_artifacts.final_mp4.ttl_seconds).toBe(24 * 60 * 60);
    expect(provenance.signed_artifacts.final_mp4.route_path).toContain(`/runs/${started.runId}/artifacts/final.mp4`);
    expect(provenance.export_metadata.soundtrack).toBe("provider_audio");

    const clipOneProbeIndex = mediaRunner.calls.findIndex(
      (call) => call.command === "ffprobe" && call.args[call.args.length - 1] === clipOnePath,
    );
    const clipOneNormalizeIndex = mediaRunner.calls.findIndex(
      (call) => call.command === "ffmpeg" && call.args.includes(clipOnePath),
    );
    expect(clipOneProbeIndex).toBeGreaterThanOrEqual(0);
    expect(clipOneNormalizeIndex).toBeGreaterThan(clipOneProbeIndex);

    await engine.close();
  });

  test("malformed media is rejected by ffprobe before ffmpeg normalization", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deal-pump-export-invalid-"));
    const sqlitePath = path.join(tempRoot, "deal-pump.sqlite");
    const artifactsRoot = path.join(tempRoot, "artifacts");
    const invalidClipPath = path.join(tempRoot, "invalid-clip.mp4");
    await fs.writeFile(invalidClipPath, "not-a-video");

    const normalizedBrief = createNormalizedBrief();
    const normalizeStage: StageHandler = async () => {
      return {
        type: "success",
        data: {
          normalize: {
            prompt_metadata: [],
            repair_attempted: false,
            sanitized_brief: "sanitized",
            normalized_brief: normalizedBrief,
            reason_codes: [],
          },
          normalized_brief: normalizedBrief,
        },
      };
    };
    const passThroughStage: StageHandler = async () => {
      return {
        type: "success",
        data: {
          video_generation: {
            derived_video_scenes: [
              {
                scene_id: "scene-intro",
                source_asset_ids: ["brand-wordmark-primary"],
                provider_job_reference: "vertex-veo-scene-intro",
                clip: {
                  clip_id: "clip-intro",
                  storage_path: invalidClipPath,
                  sha256: "bad-sha",
                },
              },
            ],
          },
        },
      };
    };

    const mediaRunner = createMockMediaRunner({
      invalidProbePath: invalidClipPath,
    });
    const subtitlesExport = createSubtitlesExportStageHandler({
      artifactsRootDir: artifactsRoot,
      tempRootDir: path.join(tempRoot, "tmp"),
      fixtureMode: false,
      commandRunner: mediaRunner.runner,
      routeSigningSecret: "route-secret",
    });

    const engine = await createSQLiteRunEngine({ sqlitePath, leaseDurationMs: 200 });
    await engine.initialize();
    const handlers = createStageHandlers({
      normalize: normalizeStage,
      validatePolicy: passThroughStage,
      imageGeneration: passThroughStage,
      videoGeneration: passThroughStage,
      subtitlesExport,
    });

    const started = await engine.startRun({
      idempotencyKey: "export-invalid-media",
      payload: { brief: "invalid media" },
    });

    for (let index = 0; index < 80; index += 1) {
      const claim = await engine.claimNextJob();
      if (!claim) {
        await sleep(10);
        continue;
      }

      await engine.processClaim(claim, handlers);
      const projection = await engine.getRunProjection(started.runId);
      if (projection.phase === "failed") {
        break;
      }
    }

    const projection = await engine.getRunProjection(started.runId);
    expect(projection.phase).toBe("failed");
    expect(projection.outcome).toBe("provider_failed");
    expect(String(projection.result?.reason)).toContain("has no video stream");

    const normalizeCalls = mediaRunner.calls.filter((call) => {
      return call.command === "ffmpeg" && call.args.includes(invalidClipPath);
    });
    expect(normalizeCalls).toHaveLength(0);

    await engine.close();
  });

  test("fixture mode deterministically exports without upstream provider clips", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deal-pump-export-fixture-"));
    const artifactsRoot = path.join(tempRoot, "artifacts");
    const mediaRunner = createMockMediaRunner();

    const subtitlesExport = createSubtitlesExportStageHandler({
      artifactsRootDir: artifactsRoot,
      tempRootDir: path.join(tempRoot, "tmp"),
      fixtureMode: false,
      commandRunner: mediaRunner.runner,
      routeSigningSecret: "route-secret",
      now: () => new Date("2026-04-02T11:00:00.000Z"),
    });

    const result = await subtitlesExport({
      runId: "fixture-run-1",
      stage: "subtitles_export",
      attemptCount: 1,
      payload: {
        fixture_mode: true,
        normalized_brief: createNormalizedBrief(),
      },
    });

    expect(result.type).toBe("success");
    const stageData = (result as { type: "success"; data?: Record<string, unknown> }).data as {
      subtitles_export: {
        export_metadata: {
          fixture_mode: boolean;
        };
      };
    };
    expect(stageData.subtitles_export.export_metadata.fixture_mode).toBe(true);

    await expect(fs.stat(path.join(artifactsRoot, "runs", "fixture-run-1", "final.mp4"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(artifactsRoot, "runs", "fixture-run-1", "provenance.json"))).resolves.toBeDefined();
  });
});
