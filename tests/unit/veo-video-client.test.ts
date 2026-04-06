import { createVertexVeoVideoClient } from "@shared/index";

describe("vertex veo video client polling", () => {
  test("quantizes unsupported scene duration before calling Veo", async () => {
    let generateRequest: unknown;

    const client = createVertexVeoVideoClient({
      project: "project-id",
      location: "us-central1",
      outputRootDir: "/tmp/output",
      createClient: () => ({
        models: {
          generateVideos: async (request: unknown) => {
            generateRequest = request;
            return {
              name: "operations/test-op",
              done: false,
            };
          },
        },
        operations: {
          getVideosOperation: async () => ({
            done: false,
          }),
        },
      }),
    });

    await client.startSceneVideoGeneration({
      runId: "run-1",
      scene: {
        sceneId: "scene-1",
        sceneType: "intro",
        narrative:
          "A woman speaking straight to camera about why this is the best ecommerce product.",
        durationSeconds: 3,
        sequencePosition: "opening",
        nextNarrative: "Show the product interface with smooth motion and a complete product benefit line.",
      },
      firstFrame: {
        stillId: "still-1",
        storagePath: "mock://still-1.png",
        canonicalMime: "image/png",
        width: 1080,
        height: 2430,
        sha256: "sha",
      },
      sourceAssetIds: ["hook-spokeswoman-dealpump"],
      prompt: {
        prompt_id: "prompt-id",
        version: 1,
        template_hash: "template-hash",
        template: "Create a short vertical social clip.",
      },
      model: "veo-3.1-fast-generate-001",
    });

    expect(generateRequest).toMatchObject({
      config: {
        durationSeconds: 4,
        aspectRatio: "9:16",
        enhancePrompt: true,
        personGeneration: "ALLOW_ADULT",
        resolution: "1080p",
        generateAudio: true,
      },
    });
    expect((generateRequest as { prompt?: string }).prompt).toContain(
      "Narrative: A presenter presenting in a clean studio about introducing strong ecommerce product.",
    );
    expect((generateRequest as { prompt?: string }).prompt).toContain(
      "Scene position: opening",
    );
    expect((generateRequest as { prompt?: string }).prompt).toContain(
      "Next scene summary: Show the product interface with smooth motion and a complete product benefit line.",
    );
    expect((generateRequest as { prompt?: string }).prompt).toContain(
      "Transition guidance: begin and end on natural edit points",
    );
  });

  test("reconstructs an operation object when polling by stored provider reference", async () => {
    let receivedOperation: unknown;

    const client = createVertexVeoVideoClient({
      project: "project-id",
      location: "us-central1",
      outputRootDir: "/tmp/output",
      createClient: () => ({
        models: {
          generateVideos: async () => ({
            name: "operations/test-op",
            done: false,
          }),
        },
        operations: {
          getVideosOperation: async (request: unknown) => {
            receivedOperation = (request as { operation: unknown }).operation;
            return {
              done: true,
              response: {
                generatedVideos: [
                  {
                    video: {
                      videoBytes: Buffer.from("video-bytes").toString("base64"),
                      durationSeconds: 4,
                      fps: 24,
                      width: 1080,
                      height: 2430,
                    },
                  },
                ],
              },
            };
          },
        },
      }),
    });

    const status = await client.getSceneVideoGenerationStatus({
      providerJobReference: "operations/test-op",
    });

    expect(receivedOperation).toMatchObject({
      name: "operations/test-op",
    });
    expect(
      typeof (receivedOperation as { _fromAPIResponse?: unknown })
        ._fromAPIResponse,
    ).toBe("function");
    expect(status.status).toBe("succeeded");
    if (status.status !== "succeeded") {
      return;
    }

    expect(status.clip.width).toBe(1080);
    expect(status.clip.height).toBe(2430);
  });

  test("accepts completed operation payloads that return response.video directly", async () => {
    const client = createVertexVeoVideoClient({
      project: "project-id",
      location: "us-central1",
      outputRootDir: "/tmp/output",
      createClient: () => ({
        models: {
          generateVideos: async () => ({
            name: "operations/test-op",
            done: false,
          }),
        },
        operations: {
          getVideosOperation: async () => ({
            done: true,
            response: {
              video: {
                videoBytes:
                  Buffer.from("video-bytes-direct").toString("base64"),
                durationSeconds: 4,
                fps: 24,
                width: 1080,
                height: 2430,
              },
            },
          }),
        },
      }),
    });

    const status = await client.getSceneVideoGenerationStatus({
      providerJobReference: "operations/test-op",
    });

    expect(status.status).toBe("succeeded");
    if (status.status !== "succeeded") {
      return;
    }

    expect(status.clip.duration_seconds).toBe(4);
    expect(status.clip.width).toBe(1080);
    expect(status.clip.height).toBe(2430);
  });

  test("accepts raw vertex operation payloads that return response.videos", async () => {
    const client = createVertexVeoVideoClient({
      project: "project-id",
      location: "us-central1",
      outputRootDir: "/tmp/output",
      createClient: () => ({
        models: {
          generateVideos: async () => ({
            name: "operations/test-op",
            done: false,
          }),
        },
        operations: {
          getVideosOperation: async () => ({
            done: true,
            response: {
              videos: [
                {
                  bytesBase64Encoded:
                    Buffer.from("video-bytes-vertex").toString("base64"),
                  mimeType: "video/mp4",
                },
              ],
            },
          }),
        },
      }),
    });

    const status = await client.getSceneVideoGenerationStatus({
      providerJobReference: "operations/test-op",
    });

    expect(status.status).toBe("succeeded");
    if (status.status !== "succeeded") {
      return;
    }

    expect(status.clip.canonical_mime).toBe("video/mp4");
    expect(status.clip.byte_size).toBe(
      Buffer.from("video-bytes-vertex").byteLength,
    );
  });
});
