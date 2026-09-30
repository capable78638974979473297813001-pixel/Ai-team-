import { describe, expect, it } from "vitest";
import { clampLimits, Budget, DEFAULT_LIMITS } from "@/server/orchestrator/budget";
import { findDisagreements, heuristicPlan } from "@/server/orchestrator/engine";
import { extractJson, parseJudgement, parsePlan, parseReview, parseWork } from "@/server/orchestrator/protocol";

describe("protocol parsing", () => {
  it("parses the work format", () => {
    const w = parseWork("SUMMARY: Mostly fine.\nFINDINGS:\n- [F1] Missing rate limits.\n- [F2] No tests for auth.\nDETAILS:\nSee src/auth.ts");
    expect(w.summary).toBe("Mostly fine.");
    expect(w.findings).toEqual([
      { id: "F1", text: "Missing rate limits." },
      { id: "F2", text: "No tests for auth." },
    ]);
    expect(w.details).toBe("See src/auth.ts");
  });

  it("falls back to bullets when the format is ignored", () => {
    const w = parseWork("Here is what I found.\n- The API has no pagination\n- Errors leak stack traces");
    expect(w.findings.map((f) => f.id)).toEqual(["F1", "F2"]);
  });

  it("extracts JSON from fenced or bare text, ignoring braces in strings", () => {
    expect(extractJson('Sure!\n```json\n{"a": "}{", "b": 1}\n```')).toEqual({ a: "}{", b: 1 });
    expect(extractJson('prefix {"x": {"y": 2}} suffix')).toEqual({ x: { y: 2 } });
    expect(extractJson("no json here")).toBeNull();
  });

  it("validates plans and rejects malformed ones", () => {
    expect(parsePlan('{"summary":"s","subtasks":[{"agent":"claude","title":"t","instructions":"do"}]}')?.subtasks[0]).toMatchObject({
      agent: "claude",
      verify: true,
      webSearch: false,
    });
    expect(parsePlan('{"subtasks": []}')).toBeNull();
    expect(parsePlan("garbage")).toBeNull();
  });

  it("normalises review verdicts", () => {
    const r = parseReview('```json\n{"summary":"ok","reviews":[{"finding":"[f1]","verdict":"Incorrect","note":"n"},{"finding":"F2","verdict":"maybe"}]}\n```');
    expect(r.reviews[0]).toMatchObject({ finding: "F1", verdict: "incorrect" });
    expect(r.reviews[1]!.verdict).toBe("uncertain");
  });

  it("defaults judgements safely", () => {
    const j = parseJudgement("I think the reviewer is right.");
    expect(j.anotherRound).toBe(false);
    expect(j.rulings).toEqual([]);
  });
});

describe("disagreement detection", () => {
  it("flags incorrect and incomplete verdicts only", () => {
    const item: any = {
      title: "Code review",
      agent: { key: "claude", name: "Claude" },
      result: { findings: [{ id: "F1", text: "A" }, { id: "F2", text: "B" }, { id: "F3", text: "C" }] },
    };
    const reviews: any = [
      {
        item,
        reviewer: { key: "chatgpt", name: "ChatGPT" },
        review: {
          reviews: [
            { finding: "F1", verdict: "correct", note: "" },
            { finding: "F2", verdict: "incorrect", note: "wrong" },
            { finding: "F3", verdict: "incomplete", note: "partial" },
            { finding: "F9", verdict: "incorrect", note: "unknown id" },
          ],
        },
        messageId: "m",
      },
    ];
    const d = findDisagreements(reviews);
    expect(d.map((x) => x.findingId)).toEqual(["F2", "F3"]);
    expect(d[0]).toMatchObject({ id: "D1", authorName: "Claude", reviewerName: "ChatGPT", claim: "B" });
  });
});

describe("budget", () => {
  it("clamps limits into safe bounds", () => {
    const l = clampLimits({ maxRounds: 99, maxCalls: 0, maxAgents: 3, maxRuntimeMs: 1 });
    expect(l).toMatchObject({ maxRounds: 4, maxCalls: 2, maxAgents: 3, maxRuntimeMs: 30_000 });
  });

  it("reserves calls and enforces time and cost", () => {
    let now = 0;
    const b = new Budget({ ...DEFAULT_LIMITS, maxCalls: 3, maxCostUsd: 0.01 }, 0, undefined, () => now);
    expect(b.canCall(1)).toBe(true);
    b.begin();
    b.begin();
    expect(b.canCall(1)).toBe(false);
    expect(b.canSynthesize()).toBe(true);
    b.begin();
    expect(b.canSynthesize()).toBe(false);

    const c = new Budget({ ...DEFAULT_LIMITS, maxCostUsd: 0.01 }, 0, undefined, () => now);
    c.record("anthropic", "claude-opus-5-5", { inputTokens: 1000, outputTokens: 1000 }); // $0.024
    expect(c.exhaustedReason()).toMatch(/cost limit/);
    expect(c.usage().costUsd).toBeCloseTo(0.024);

    now = DEFAULT_LIMITS.maxRuntimeMs + 1;
    expect(new Budget(DEFAULT_LIMITS, 0, undefined, () => now).exhaustedReason()).toMatch(/time limit/);
  });

  it("reports unknown cost rather than a misleading zero", () => {
    const b = new Budget(DEFAULT_LIMITS, 0);
    b.record("xai", "grok-unknown", { inputTokens: 10, outputTokens: 10 });
    expect(b.usage().costUsd).toBeNull();
  });
});

describe("heuristic planner", () => {
  it("gives every usable agent a role-based subtask and skips repo-only agents without a repo", () => {
    const agents: any = [
      { key: "claude", roleTitle: "Lead Developer", roleInstructions: "Inspect code", capabilities: ["chat", "coding", "web_research"] },
      { key: "cursor", roleTitle: "Coding Agent", roleInstructions: "", capabilities: ["coding", "repository_access"] },
    ];
    const p = heuristicPlan("What is the latest version of Next.js?", agents, false);
    expect(p.subtasks.map((s) => s.agent)).toEqual(["claude"]);
    expect(p.subtasks[0]!.webSearch).toBe(true);
    expect(heuristicPlan("x", agents, true).subtasks).toHaveLength(2);
  });
});
