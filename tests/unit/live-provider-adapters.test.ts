import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  createVertexGeminiFlashImageClient,
  createVertexVeoVideoClient,
  type GeminiSceneStillRequest,
  type VeoSceneVideoStartRequest,
} from "@shared/index";

function buildGeminiRequest(): GeminiSceneStillRequest {
  return {
    runId: "run-live-gemini",
    model: "gemini-2.5-flash-image",
    scene: {
      sceneId: "scene-1",
      sceneType: "intro",
      narrative: "Logo reveal",
      requestedTransform: "overlay",
    },
    sourceAssets: [
      {
        assetId: "brand-wordmark-primary",
        filePath: "/tmp/asset.png",
        canonicalMime: "image/png",
        byteSize: 123,
        width: 1280,
        height: 720,
      },
    ],
    prompt: {
      prompt_id: "generate_scene_still_gemini_2_5_flash_image",
      version: 1,
      template_hash: "hash",
      template: "Generate still",
    },
  };
}

function buildVeoStartRequest(stillPath: string): VeoSceneVideoStartRequest {
  return {
    runId: "run-live-veo",
    model: "veo-3.1-generate-preview",
    scene: {
      sceneId: "scene-live-1",
      sceneType: "intro",
      narrative: "Animate opening",
      durationSeconds: 5,
    },
    prompt: {
      prompt_id: "generate_scene_video_veo_3_1_i2v",
      version: 1,
      template_hash: "hash",
      template: "Animate scene",
    },
    firstFrame: {
      stillId: "still-1",
      storagePath: stillPath,
      canonicalMime: "image/png",
      width: 1280,
      height: 720,
      sha256: "still-sha",
    },
    sourceAssetIds: ["brand-wordmark-primary"],
  };
}

describe("live provider adapters", () => {
  test("vertex gemini adapter writes local still and computes checksum from bytes", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deal-pump-live-gemini-"));
    const imageBytes = Buffer.from("png-bytes-for-test");

    const client = createVertexGeminiFlashImageClient({
      project: "test-project",
      location: "us-central1",
      outputRootDir: tempRoot,
      now: () => 123,
      createClient: () => {
        return {
          models: {
            generateImages: async () => {
              return {
                responseId: "vertex-response-1",
                generatedImages: [
                  {
                    image: {
                      imageBytes: imageBytes.toString("base64"),
                      mimeType: "image/png",
                      width: 960,
                      height: 540,
                    },
                  },
                ],
              };
            },
          },
        };
      },
    });

    const response = await client.generateSceneStill(buildGeminiRequest());
    const persisted = await fs.readFile(response.still.storage_path);

    expect(response.provider_job_reference).toBe("vertex-response-1");
    expect(persisted.equals(imageBytes)).toBe(true);
    expect(response.still.sha256).toBe(createHash("sha256").update(imageBytes).digest("hex"));
    expect(response.still.byte_size).toBe(imageBytes.byteLength);
    expect(response.still.width).toBe(960);
    expect(response.still.height).toBe(540);
  });

  test("vertex gemini adapter wraps malformed SDK payload failures", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deal-pump-live-gemini-fail-"));

    const client = createVertexGeminiFlashImageClient({
      project: "test-project",
      location: "us-central1",
      outputRootDir: tempRoot,
      createClient: () => {
        return {
          models: {
            generateImages: async () => {
              return {};
            },
          },
        };
      },
    });

    await expect(client.generateSceneStill(buildGeminiRequest())).rejects.toThrow(
      "vertex gemini generateSceneStill failed",
    );
  });

  test("vertex veo adapter materializes remote output to local file path", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deal-pump-live-veo-"));
    const stillPath = path.join(tempRoot, "still.png");
    await fs.writeFile(stillPath, Buffer.from("still-bytes"));
    const videoBytes = Buffer.from("mp4-test-bytes");

    const client = createVertexVeoVideoClient({
      project: "test-project",
      location: "us-central1",
      outputRootDir: tempRoot,
      fetchBinary: async () => videoBytes,
      createClient: () => {
        return {
          models: {
            generateVideos: async () => {
              return {
                name: "operations/veo-job-1",
              };
            },
          },
          operations: {
            getVideosOperation: async () => {
              return {
                done: true,
                response: {
                  generatedVideos: [
                    {
                      video: {
                        uri: "https://example.test/video.mp4",
                        width: 1280,
                        height: 720,
                        fps: 24,
                        durationSeconds: 5,
                      },
                    },
                  ],
                },
              };
            },
          },
        };
      },
    });

    const started = await client.startSceneVideoGeneration(buildVeoStartRequest(stillPath));
    const status = await client.getSceneVideoGenerationStatus({
      providerJobReference: started.provider_job_reference,
    });

    expect(status.status).toBe("succeeded");
    if (status.status !== "succeeded") {
      return;
    }

    const persisted = await fs.readFile(status.clip.storage_path);
    expect(path.isAbsolute(status.clip.storage_path)).toBe(true);
    expect(persisted.equals(videoBytes)).toBe(true);
    expect(status.clip.byte_size).toBe(videoBytes.byteLength);
    expect(status.clip.sha256).toBe(createHash("sha256").update(videoBytes).digest("hex"));
  });

  test("vertex veo adapter fails cleanly on unsupported URI scheme", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deal-pump-live-veo-gs-"));
    const stillPath = path.join(tempRoot, "still.png");
    await fs.writeFile(stillPath, Buffer.from("still-bytes"));

    const client = createVertexVeoVideoClient({
      project: "test-project",
      location: "us-central1",
      outputRootDir: tempRoot,
      fetchBinary: async () => Buffer.from("unused"),
      createClient: () => {
        return {
          models: {
            generateVideos: async () => {
              return {
                name: "operations/veo-job-gs",
              };
            },
          },
          operations: {
            getVideosOperation: async () => {
              return {
                done: true,
                response: {
                  generatedVideos: [
                    {
                      video: {
                        uri: "gs://bucket/video.mp4",
                      },
                    },
                  ],
                },
              };
            },
          },
        };
      },
    });

    const started = await client.startSceneVideoGeneration(buildVeoStartRequest(stillPath));
    const status = await client.getSceneVideoGenerationStatus({
      providerJobReference: started.provider_job_reference,
    });

    expect(status.status).toBe("failed");
    if (status.status !== "failed") {
      return;
    }

    expect(status.reason).toContain("unsupported video URI scheme");
  });
});
