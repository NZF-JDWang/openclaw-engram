import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddingClient, encodeEmbedding } from "../src/kb/embeddings.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EmbeddingClient", () => {
  it("returns nulls when embedding is disabled", async () => {
    const client = new EmbeddingClient({
      embedEnabled: false,
      embedApiUrl: "http://localhost:11434/v1/embeddings",
      embedApiModel: "nomic-embed-text",
      embedApiKey: undefined,
      embedBatchSize: 2,
    });

    await expect(client.embed(["a", "b"])).resolves.toEqual([null, null]);
  });

  it("batches requests and tolerates failed batches without aborting all embeddings", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const call = fetchMock.mock.calls.length;
      if (call === 1) {
        return {
          ok: true,
          json: async () => ({
            data: (payload.input ?? []).map((_, index) => ({ embedding: [index + 0.1, index + 0.2] })),
          }),
        } satisfies Partial<Response>;
      }
      return {
        ok: false,
        status: 500,
      } satisfies Partial<Response>;
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new EmbeddingClient({
      embedEnabled: true,
      embedApiUrl: "http://localhost:11434/v1/embeddings",
      embedApiModel: "nomic-embed-text",
      embedApiKey: "secret",
      embedBatchSize: 2,
    });

    const embeddings = await client.embed(["first", "second", "third"]);

    expect(embeddings[0]).toEqual([0.1, 0.2]);
    expect(embeddings[1]).toEqual([1.1, 1.2]);
    expect(embeddings[2]).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("encodes vectors as float32 little-endian bytes", () => {
    const bytes = encodeEmbedding([1.5, -2]);
    expect(bytes.byteLength).toBe(8);
  });
});
