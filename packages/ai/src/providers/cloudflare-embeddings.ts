import type { EmbeddingProvider, ModelPolicy } from "@darkforest/contracts";
import { AIError } from "@darkforest/contracts";
import { redactKeys } from "../credentials.js";

/**
 * Cloudflare Workers AI embeddings — @cf/baai/bge-base-en-v1.5. ADR-009.
 *
 * 768 dimensions, matching the `halfvec(768)` schema in docs/03 § 6 exactly.
 * Verified live 2026-09-04.
 *
 * Chosen because it is the only free embedding option whose terms permit real
 * user content: Cloudflare states it neither creates nor trains the models and
 * does not train on customer content. Gemini's free tier is more generous but
 * explicitly warns against personal data, which rules it out for anything but
 * benchmarking.
 *
 * Budget: 10,000 neurons/day, shared across ALL Workers AI usage. This model
 * costs ~6,058 neurons per 1M input tokens, so roughly 1.65M embedding tokens
 * per day — about 55,000 memories. Comfortable, but the budget is shared, so
 * dialogue must never be routed here.
 */

const MODEL = "@cf/baai/bge-base-en-v1.5";

const CLOUDFLARE_POLICY: ModelPolicy = {
  eligibility: "production",
  trainsOnInput: false,
  forbidsPersonalData: false,
  retentionDays: 0,
  source:
    "Cloudflare Workers AI data-usage docs: inputs, outputs and embeddings are Customer Content; " +
    "Cloudflare neither creates nor trains the models and does not train on customer content.",
  verifiedOn: "2026-09-04",
};

export interface CloudflareEmbeddingConfig {
  accountId: string;
  /** Acquired per-call from the CredentialRegistry. Never stored on the instance. */
  getToken: () => { id: string; key: string } | null;
  onSuccess?: (credentialId: string, tokens: number) => void;
  onFailure?: (credentialId: string, kind: "rate_limited" | "rejected" | "error") => void;
  timeoutMs?: number;
  /**
   * Texts per request. The API accepts an array; batching is the difference
   * between one call and a hundred against a shared daily neuron budget.
   */
  batchSize?: number;
}

interface CloudflareResponse {
  success: boolean;
  result?: { data?: number[][] };
  errors?: Array<{ code: number; message: string }>;
}

export class CloudflareEmbeddingProvider implements EmbeddingProvider {
  readonly id = "cloudflare:bge-base-en-v1.5";
  readonly dimensions = 768;
  readonly version = 1;
  readonly policy = CLOUDFLARE_POLICY;

  private readonly config: Required<Omit<CloudflareEmbeddingConfig, "onSuccess" | "onFailure">> &
    Pick<CloudflareEmbeddingConfig, "onSuccess" | "onFailure">;

  /**
   * Content-hash cache. Identical text embeds once, ever — the same memory
   * re-embedded after an edit, or the same phrase across worlds, costs nothing
   * the second time (docs/08 § 8).
   */
  private readonly cache = new Map<string, Float32Array>();
  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(config: CloudflareEmbeddingConfig) {
    this.config = {
      accountId: config.accountId,
      getToken: config.getToken,
      timeoutMs: config.timeoutMs ?? 30_000,
      batchSize: config.batchSize ?? 32,
      ...(config.onSuccess === undefined ? {} : { onSuccess: config.onSuccess }),
      ...(config.onFailure === undefined ? {} : { onFailure: config.onFailure }),
    };
  }

  get stats(): { cacheHits: number; cacheMisses: number; cacheSize: number } {
    return {
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      cacheSize: this.cache.size,
    };
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const results = new Array<Float32Array | undefined>(texts.length);
    const pending: Array<{ index: number; text: string }> = [];

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i] ?? "";
      const cached = this.cache.get(text);
      if (cached) {
        results[i] = cached;
        this.cacheHits += 1;
      } else {
        pending.push({ index: i, text });
        this.cacheMisses += 1;
      }
    }

    for (let start = 0; start < pending.length; start += this.config.batchSize) {
      const batch = pending.slice(start, start + this.config.batchSize);
      const vectors = await this.callApi(batch.map((b) => b.text));
      for (let j = 0; j < batch.length; j++) {
        const entry = batch[j];
        const vector = vectors[j];
        if (entry && vector) {
          results[entry.index] = vector;
          this.cache.set(entry.text, vector);
        }
      }
    }

    return results.map((v) => v ?? new Float32Array(this.dimensions));
  }

  private async callApi(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const credential = this.config.getToken();
    if (!credential) {
      throw new AIError("BUDGET_EXCEEDED", "No Cloudflare credential available", this.id);
    }

    let response: Response;
    try {
      response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}/ai/run/${MODEL}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${credential.key}`,
          },
          body: JSON.stringify({ text: texts }),
          signal: AbortSignal.timeout(this.config.timeoutMs),
        },
      );
    } catch (cause) {
      this.config.onFailure?.(credential.id, "error");
      // redactKeys because fetch failures sometimes echo request headers back.
      throw new AIError("TIMEOUT", redactKeys((cause as Error).message), this.id);
    }

    if (response.status === 401 || response.status === 403) {
      // Never auto-recovers — a revoked or misscoped token will not start working.
      this.config.onFailure?.(credential.id, "rejected");
      throw new AIError("AUTH_FAILED", `Cloudflare rejected credential ${credential.id}`, this.id);
    }

    if (response.status === 429) {
      this.config.onFailure?.(credential.id, "rate_limited");
      throw new AIError("RATE_LIMITED", "Workers AI neuron budget exhausted", this.id, 60_000);
    }

    const body = (await response.json()) as CloudflareResponse;

    if (!body.success || !body.result?.data) {
      this.config.onFailure?.(credential.id, "error");
      const detail = body.errors?.map((e) => `${String(e.code)}: ${e.message}`).join("; ") ?? "unknown";
      throw new AIError("SERVER_ERROR", redactKeys(detail), this.id);
    }

    const data = body.result.data;

    // Guard the schema contract. A dimension change would silently corrupt every
    // vector written afterwards, and the corruption would only surface later as
    // mysteriously poor recall.
    const first = data[0];
    if (first !== undefined && first.length !== this.dimensions) {
      throw new AIError(
        "MALFORMED_OUTPUT",
        `Expected ${String(this.dimensions)} dimensions, got ${String(first.length)}. ` +
          `The halfvec(768) schema and every stored embedding assume 768.`,
        this.id,
      );
    }

    // Rough token estimate for budget accounting; the API does not report usage.
    const estimatedTokens = Math.ceil(texts.reduce((n, t) => n + t.length, 0) / 3.6);
    this.config.onSuccess?.(credential.id, estimatedTokens);

    return data.map((v) => Float32Array.from(v));
  }
}
