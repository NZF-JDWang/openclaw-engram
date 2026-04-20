import type { EngramConfig } from "../config.js";

export class EmbeddingClient {
  constructor(private readonly config: Pick<EngramConfig, "embedEnabled" | "embedApiUrl" | "embedApiModel" | "embedApiKey" | "embedBatchSize">) {}

  async embed(texts: string[]): Promise<Array<number[] | null>> {
    if (!this.config.embedEnabled) {
      return texts.map(() => null);
    }
    if (texts.length === 0) {
      return [];
    }

    const results: Array<number[] | null> = [];
    for (let index = 0; index < texts.length; index += this.config.embedBatchSize) {
      const batch = texts.slice(index, index + this.config.embedBatchSize);
      const embeddedBatch = await this.embedBatchWithRetry(batch);
      results.push(...embeddedBatch);
    }
    return results;
  }

  private async embedBatchWithRetry(batch: string[]): Promise<Array<number[] | null>> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.embedBatch(batch);
      } catch (error) {
        lastError = error;
      }
    }
    void lastError;
    return batch.map(() => null);
  }

  private async embedBatch(batch: string[]): Promise<Array<number[] | null>> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(this.config.embedApiUrl);
    } catch {
      throw new Error(`embedApiUrl is not a valid URL: ${this.config.embedApiUrl}`);
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error(`embedApiUrl must use http or https (got ${parsedUrl.protocol})`);
    }
    const response = await fetch(parsedUrl.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.config.embedApiKey ? { authorization: `Bearer ${this.config.embedApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.config.embedApiModel,
        input: batch,
      }),
    });

    if (!response.ok) {
      throw new Error(`Embedding request failed with status ${response.status}`);
    }

    const payload = await response.json() as { data?: Array<{ embedding?: unknown }> };
    const rows = Array.isArray(payload.data) ? payload.data : [];
    return batch.map((_, index) => {
      const embedding = rows[index]?.embedding;
      if (!Array.isArray(embedding) || !embedding.every((value) => typeof value === "number")) {
        return null;
      }
      return embedding;
    });
  }
}

export function encodeEmbedding(vector: number[]): Uint8Array {
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  vector.forEach((value, index) => {
    view.setFloat32(index * 4, value, true);
  });
  return bytes;
}

export function decodeEmbedding(value: Uint8Array | ArrayBuffer, dimensions?: number | null): number[] {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  const length = dimensions && dimensions > 0 ? dimensions : Math.floor(bytes.byteLength / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector: number[] = [];
  for (let index = 0; index < length; index += 1) {
    vector.push(view.getFloat32(index * 4, true));
  }
  return vector;
}
