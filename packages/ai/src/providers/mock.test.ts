import { beforeEach, describe, expect, it } from "vitest";
import {
  AIError,
  ExtractionResultSchema,
  type GenerateRequest,
  type ModelDescriptor,
} from "@darkforest/contracts";
import { MockProvider } from "./mock.js";
import { probePrompt } from "./prompt-probe.js";

/**
 * A realistic system prompt following the docs/09 § 3 skeleton. Shared by the
 * tests so that a change to the prompt format which breaks the probe shows up
 * here rather than silently degrading the mock into a stub.
 */
const SYSTEM_PROMPT = `You are voicing a single character in an interactive story.

── WORLD ────────────────────────────────────────────
Ravenhold — fantasy
Tone: grim · Narrative perspective: second

Rules of this world (binding):
• The dead cannot be resurrected.

── YOU ARE ELENA ───────────────
Sister to Marcus

Personality: Guarded, loyal, quick to anger.
Traits: guarded, loyal
Speech: Clipped sentences. Rarely finishes a thought aloud.

How you speak (match this voice):
› "Don't."
› "I said I'd wait. I didn't say I'd forgive you."

You never: swears, speaks of her mother

Your goals:
• [long_term] Find who killed the king

── HOW YOU SEE OTHERS ───────────────────────────────
The user — wary ally (trust 34, hostility 12)

── WHAT YOU KNOW ────────────────────────────────────
These are your memories. Others may remember differently, or not at all.
• [day 14] The user promised Elena he would return before sunset.
• [day 12] The user owns Ravenblade, a legendary sword.
• [day 9] Marcus was seen near the northern gate at midnight.

── RIGHT NOW ────────────────────────────────────
Day 21, evening · Ravenhold
Gold: 1240 ·
Present: Elena, Marcus
`;

function request(over: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    taskClass: "dialogue",
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: "I walk into the hall." }],
    maxTokens: 400,
    temperature: 0.8,
    timeoutMs: 12_000,
    meta: { requestId: "req_1", turnId: "turn_1", characterId: "elena" },
    ...over,
  };
}

describe("probePrompt", () => {
  const probe = probePrompt(SYSTEM_PROMPT);

  it("finds the character name from the section heading", () => {
    expect(probe.characterName).toBe("ELENA");
  });

  it("extracts every day-stamped memory", () => {
    expect(probe.memories).toHaveLength(3);
    expect(probe.memories[0]).toEqual({
      day: 14,
      content: "The user promised Elena he would return before sunset.",
    });
  });

  it("reads the present characters", () => {
    expect(probe.presentCharacters).toEqual(["Elena", "Marcus"]);
  });

  it("reads world day and location", () => {
    expect(probe.worldDay).toBe(21);
    expect(probe.location).toBe("Ravenhold");
  });

  it("reads the forbidden list", () => {
    expect(probe.forbidden).toEqual(["swears", "speaks of her mother"]);
  });

  it("detects voice anchors", () => {
    expect(probe.hasVoiceAnchors).toBe(true);
  });

  it("returns empty results for an unstructured prompt rather than throwing", () => {
    // The mock must keep working while the prompt format evolves.
    const empty = probePrompt("just some text with no sections at all");
    expect(empty.characterName).toBeNull();
    expect(empty.memories).toEqual([]);
    expect(empty.presentCharacters).toEqual([]);
  });

  it("survives an empty string", () => {
    expect(() => probePrompt("")).not.toThrow();
  });
});

describe("MockProvider — determinism", () => {
  let provider: MockProvider;
  let model: ModelDescriptor;

  beforeEach(() => {
    provider = new MockProvider();
    model = provider.models.find((m) => m.tier === "standard")!;
  });

  it("returns identical output for identical input", async () => {
    const a = await provider.generate(request(), model);
    const b = await provider.generate(request(), model);
    expect(a.text).toBe(b.text);
  });

  it("returns different output for a different user message", async () => {
    const a = await provider.generate(request(), model);
    const b = await provider.generate(
      request({ messages: [{ role: "user", content: "I say nothing at all." }] }),
      model,
    );
    expect(a.text).not.toBe(b.text);
  });

  it("returns different output for a different seed", async () => {
    const other = new MockProvider({ seed: "different" });
    const a = await provider.generate(request(), model);
    const b = await other.generate(request(), other.models[1]!);
    expect(a.text).not.toBe(b.text);
  });

  it("reports one descriptor per tier", () => {
    expect(provider.models.map((m) => m.tier)).toEqual(["fast", "standard", "deep"]);
  });

  it("declares itself production-eligible and non-training, honestly", () => {
    // Nothing leaves the process, so this is accurate rather than convenient.
    expect(model.policy.eligibility).toBe("production");
    expect(model.policy.trainsOnInput).toBe(false);
    expect(model.pools).toContain("private");
  });
});

describe("MockProvider — the memory assertion surface", () => {
  let provider: MockProvider;
  let model: ModelDescriptor;

  beforeEach(() => {
    provider = new MockProvider();
    model = provider.models[1]!;
  });

  it("echoes a retrieved memory, so a dropped memory is detectable", async () => {
    const res = await provider.generate(request(), model);
    const echoed = probePrompt(SYSTEM_PROMPT).memories.some((m) => res.text.includes(m.content));
    expect(echoed).toBe(true);
  });

  it("reports the memory count, so budget-packing regressions are visible", async () => {
    const res = await provider.generate(request(), model);
    expect(res.text).toContain("mem=3");
  });

  it("flags the no-memories case explicitly instead of faking a plausible reply", async () => {
    // This is the failure Phase 1 exists to catch: retrieval returning nothing
    // while the response still looks fine.
    const res = await provider.generate(
      request({ system: "── YOU ARE ELENA ───\nPersonality: guarded." }),
      model,
    );
    expect(res.text).toContain("no-memories");
  });
});

describe("MockProvider — structured output", () => {
  let provider: MockProvider;
  let model: ModelDescriptor;

  beforeEach(() => {
    provider = new MockProvider();
    model = provider.models[0]!;
  });

  it("produces extraction output that passes the real schema", async () => {
    // Proves the mock is honest: if it emitted something the production
    // validator would reject, every extraction test built on it would be a lie.
    const res = await provider.generate(
      request({
        taskClass: "extract",
        messages: [{ role: "user", content: "I promised Elena I would return before sunset." }],
      }),
      model,
    );
    const parsed = ExtractionResultSchema.safeParse(JSON.parse(res.text));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.memories.length).toBeGreaterThan(0);
  });

  it("weights an irreversible act above a routine one", async () => {
    const betrayal = await provider.generate(
      request({ taskClass: "extract", messages: [{ role: "user", content: "I betray Marcus." }] }),
      model,
    );
    const gift = await provider.generate(
      request({ taskClass: "extract", messages: [{ role: "user", content: "I gave her bread." }] }),
      model,
    );
    const impOf = (text: string): number =>
      (ExtractionResultSchema.parse(JSON.parse(text)).memories[0]?.importance ?? 0);
    expect(impOf(betrayal.text)).toBeGreaterThan(impOf(gift.text));
  });

  it("extracts nothing from an uneventful turn", async () => {
    // docs/04 § 4 — most turns contain nothing worth remembering.
    const res = await provider.generate(
      request({ taskClass: "extract", messages: [{ role: "user", content: "I look around." }] }),
      model,
    );
    expect(ExtractionResultSchema.parse(JSON.parse(res.text)).memories).toHaveLength(0);
  });

  it("attaches a relationship delta with a reason, never without", async () => {
    const res = await provider.generate(
      request({ taskClass: "extract", messages: [{ role: "user", content: "I betray Marcus." }] }),
      model,
    );
    const parsed = ExtractionResultSchema.parse(JSON.parse(res.text));
    for (const delta of parsed.relationshipDeltas) {
      expect(delta.reason.length).toBeGreaterThanOrEqual(8);
    }
  });

  it("plans using the characters actually present", async () => {
    const res = await provider.generate(request({ taskClass: "plan" }), model);
    expect(JSON.parse(res.text)).toMatchObject({ responders: ["Elena", "Marcus"] });
  });
});

describe("MockProvider — failure injection", () => {
  const model = new MockProvider().models[1]!;

  it("throws RATE_LIMITED with a retry hint", async () => {
    const p = new MockProvider({ failureMode: "rate_limited", failureRate: 1 });
    await expect(p.generate(request(), model)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryAfterMs: 60_000,
    });
  });

  it("marks a rate limit as worth falling back to another model", async () => {
    // docs/08 § 6: a 429 must advance the chain, never retry the same model.
    const p = new MockProvider({ failureMode: "rate_limited", failureRate: 1 });
    const err = await p.generate(request(), model).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AIError);
    expect((err as AIError).shouldFallback).toBe(true);
  });

  it("marks a content filter as NOT worth shopping to another provider", async () => {
    const p = new MockProvider({ failureMode: "content_filter", failureRate: 1 });
    const err = await p.generate(request(), model).catch((e: unknown) => e);
    expect((err as AIError).shouldFallback).toBe(false);
  });

  it("injects timeouts and server errors", async () => {
    for (const mode of ["timeout", "server_error"] as const) {
      const p = new MockProvider({ failureMode: mode, failureRate: 1 });
      await expect(p.generate(request(), model)).rejects.toBeInstanceOf(AIError);
    }
  });

  it("produces unparseable JSON on demand, to exercise the repair path", async () => {
    const p = new MockProvider({ failureMode: "malformed_output" });
    const res = await p.generate(request({ taskClass: "extract" }), model);
    expect(() => JSON.parse(res.text) as unknown).toThrow();
  });

  it("fails deterministically — the same request always fails or always passes", async () => {
    // A flaky mock would make the retry and breaker tests worthless.
    const p = new MockProvider({ failureMode: "server_error", failureRate: 0.5 });
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        p.generate(request(), model).then(
          () => "ok",
          () => "fail",
        ),
      ),
    );
    expect(new Set(results).size).toBe(1);
  });

  it("refuses a configured block phrase, for moderation tests", async () => {
    const p = new MockProvider({ blockPhrase: "forbidden thing" });
    await expect(
      p.generate(request({ messages: [{ role: "user", content: "the forbidden thing" }] }), model),
    ).rejects.toMatchObject({ code: "CONTENT_FILTER" });
    await expect(p.generate(request(), model)).resolves.toBeDefined();
  });

  it("returns empty text when asked, so empty-response handling is testable", async () => {
    const p = new MockProvider({ failureMode: "empty" });
    expect((await p.generate(request(), model)).text).toBe("");
  });
});

describe("MockProvider — tool calls", () => {
  const provider = new MockProvider();
  const model = provider.models[1]!;
  const tools = [{ name: "record_event", description: "", parameters: {} }];

  it("emits no tool call when none is offered", async () => {
    const res = await provider.generate(
      request({ messages: [{ role: "user", content: "I betray Marcus." }] }),
      model,
    );
    expect(res.toolCalls).toEqual([]);
  });

  it("emits a tool call only when the transcript warrants one", async () => {
    const eventful = await provider.generate(
      request({ tools, messages: [{ role: "user", content: "I betray Marcus." }] }),
      model,
    );
    const dull = await provider.generate(
      request({ tools, messages: [{ role: "user", content: "I look around." }] }),
      model,
    );
    expect(eventful.toolCalls).toHaveLength(1);
    expect(eventful.finishReason).toBe("tool_calls");
    expect(dull.toolCalls).toEqual([]);
  });

  it("reuses the tool_call_id across retries so idempotency can suppress it", async () => {
    // docs/05 § 5 — retries are normal on free endpoints; double-applying is not.
    const req = request({ tools, messages: [{ role: "user", content: "I betray Marcus." }] });
    const a = await provider.generate(req, model);
    const b = await provider.generate(req, model);
    expect(a.toolCalls[0]?.id).toBe(b.toolCalls[0]?.id);
  });
});

describe("MockProvider — streaming and accounting", () => {
  const provider = new MockProvider();
  const model = provider.models[1]!;

  it("streams text then a done frame carrying the full response", async () => {
    const chunks: string[] = [];
    let done = false;
    for await (const chunk of provider.stream(request(), model)) {
      if (chunk.type === "text") chunks.push(chunk.delta);
      if (chunk.type === "done") {
        done = true;
        expect(chunk.response.text).toBe(chunks.join(""));
      }
    }
    expect(done).toBe(true);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("counts calls per model, so distribution and fallback are assertable", async () => {
    const p = new MockProvider();
    await p.generate(request(), p.models[0]!);
    await p.generate(request(), p.models[0]!);
    await p.generate(request(), p.models[2]!);
    expect(p.callCount("mock-fast")).toBe(2);
    expect(p.callCount("mock-deep")).toBe(1);
    expect(p.callCount()).toBe(3);
  });

  it("reports token usage and the tier the task maps to", async () => {
    const res = await provider.generate(request(), model);
    expect(res.usage.inputTokens).toBeGreaterThan(100);
    expect(res.usage.outputTokens).toBeGreaterThan(0);
    expect(res.tier).toBe("standard");
    expect(res.provider).toBe("mock");
  });

  it("handles every task class without throwing", async () => {
    const classes = [
      "moderate", "inject_scan", "classify", "plan", "extract",
      "dialogue", "dialogue_reaction", "narrate", "world_create",
      "character_create", "consolidate", "reflect", "summarize_chapter",
      "dialogue_deep",
    ] as const;
    for (const taskClass of classes) {
      const res = await provider.generate(request({ taskClass }), model);
      expect(res.text.length, taskClass).toBeGreaterThan(0);
    }
  });
});
