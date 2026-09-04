import { describe, expect, it } from "vitest";
import { OpenRouterProvider } from "./openrouter.js";
import type { GenerateRequest } from "@darkforest/contracts";

describe("OpenRouterProvider", () => {
  it("initializes with models and pool definitions", () => {
    const provider = new OpenRouterProvider({
      getCredential: () => ({ id: "openrouter-1", key: "test-key" }),
    });

    expect(provider.id).toBe("openrouter");
    expect(provider.enabled).toBe(true);
    expect(provider.models.length).toBeGreaterThan(0);
    const fast = provider.models.find((m) => m.tier === "fast");
    expect(fast).toBeDefined();
    expect(fast?.id).toBe("openrouter/free");
    expect(fast?.supportsStructuredOutput).toBe(true);
    expect(fast?.supportsTools).toBe(true);
  });

  it("throws BUDGET_EXCEEDED when no credential is available", async () => {
    const provider = new OpenRouterProvider({
      getCredential: () => null,
    });
    const model = provider.models[0]!;
    const req: GenerateRequest = {
      taskClass: "dialogue",
      system: "You are Elena.",
      messages: [{ role: "user", content: "Hello" }],
      maxTokens: 50,
      temperature: 0.7,
      timeoutMs: 5000,
      meta: { requestId: "req-1" },
    };

    try {
      await provider.generate(req, model);
      expect.unreachable();
    } catch (e: unknown) {
      if (e instanceof Error && "code" in e) {
        expect(e.code).toBe("BUDGET_EXCEEDED");
        expect(e.message).toContain("No OpenRouter credential available");
      } else {
        throw e;
      }
    }
  });
});
