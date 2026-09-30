import { afterEach, describe, expect, it } from "vitest";
import { AnthropicProvider } from "@/server/providers/anthropic";
import { CursorProvider, cursorTiming } from "@/server/providers/cursor";
import { GoogleProvider } from "@/server/providers/google";
import { setFetch } from "@/server/providers/http";
import { OpenAIProvider } from "@/server/providers/openai";
import { AuthExpiredError, type Credentials, type StreamChunk } from "@/server/providers/types";
import { XAIProvider } from "@/server/providers/xai";
import { jsonResponse, mockFetch, sseResponse } from "./helpers";

const key = (k: string): Credentials => ({ method: "api_key", accessToken: k, scopes: [], extra: {} });

async function collect(gen: AsyncGenerator<StreamChunk>) {
  const out: StreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

afterEach(() => setFetch((...a) => fetch(...a)));

describe("connection method availability is honest", () => {
  it("marks unsupported and coming-soon methods", () => {
    const m = (a: { methods(): { id: string; availability: string }[] }, id: string) => a.methods().find((x) => x.id === id)!.availability;
    expect(m(new AnthropicProvider(), "oauth")).toBe("unsupported");
    expect(m(new AnthropicProvider(), "api_key")).toBe("available");
    expect(m(new XAIProvider(), "oauth")).toBe("coming_soon");
    expect(m(new CursorProvider(), "oauth")).toBe("unsupported");
    expect(m(new OpenAIProvider(), "oauth")).toBe("coming_soon"); // no OPENAI_SIWC_CLIENT_ID in tests
    expect(m(new GoogleProvider(), "oauth")).toBe("not_configured");
  });

  it("only claims subscription delegation where the provider offers it", () => {
    expect(new OpenAIProvider().capabilities("oauth")).toContain("subscription_delegation");
    expect(new OpenAIProvider().capabilities("api_key")).not.toContain("subscription_delegation");
    for (const a of [new AnthropicProvider(), new GoogleProvider(), new XAIProvider(), new CursorProvider()]) {
      expect(a.capabilities()).not.toContain("subscription_delegation");
    }
    expect(new CursorProvider().capabilities()).not.toContain("chat");
  });
});

describe("OpenAIProvider", () => {
  it("validates an API key by listing models and picks a sensible default", async () => {
    const m = mockFetch({
      "GET https://api.openai.com/v1/models": () =>
        jsonResponse({ data: [{ id: "gpt-6.1" }, { id: "gpt-6.1-mini" }, { id: "text-embedding-3" }, { id: "gpt-5" }] }),
    });
    setFetch(m.impl);
    const out = await new OpenAIProvider().connect({ method: "api_key", apiKey: "sk-test-123456789", fields: {} });
    expect(out.kind).toBe("connected");
    if (out.kind !== "connected") return;
    expect(out.account.defaultModel).toBe("gpt-6.1");
    expect(out.account.models).not.toContain("text-embedding-3");
    expect(m.calls[0]!.headers.authorization).toBe("Bearer sk-test-123456789");
  });

  it("maps 401 to AuthExpiredError", async () => {
    setFetch(mockFetch({ "GET https://api.openai.com/v1/models": () => jsonResponse({ error: { message: "bad key" } }, 401) }).impl);
    await expect(new OpenAIProvider().connect({ method: "api_key", apiKey: "sk-bad-000000", fields: {} })).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it("streams the Responses API and records usage without storing on the provider", async () => {
    const m = mockFetch({
      "POST https://api.openai.com/v1/responses": () =>
        sseResponse([
          { type: "response.web_search_call.in_progress" },
          { type: "response.web_search_call.completed" },
          { type: "response.output_text.delta", delta: "Hello " },
          { type: "response.output_text.delta", delta: "team" },
          { type: "response.completed", response: { model: "gpt-6.1", usage: { input_tokens: 12, output_tokens: 3 } } },
        ]),
    });
    setFetch(m.impl);
    const p = new OpenAIProvider();
    const conv = await p.createConversation(key("sk-x"), { model: "gpt-6.1", system: "sys" });
    const chunks = await collect(p.streamMessage(key("sk-x"), conv, "hi", { webSearch: true }));
    expect(chunks.filter((c) => c.type === "delta").map((c) => (c as any).text).join("")).toBe("Hello team");
    expect(chunks.at(-1)).toMatchObject({ type: "done", text: "Hello team", usage: { inputTokens: 12, outputTokens: 3 } });
    expect(chunks.some((c) => c.type === "tool" && c.name === "web_search")).toBe(true);
    const sent = JSON.parse(m.calls[0]!.body);
    expect(sent).toMatchObject({ model: "gpt-6.1", instructions: "sys", stream: true, store: false, tools: [{ type: "web_search" }] });
    expect(conv.history).toHaveLength(2);
  });

  it("retries without web search if the account can't use it", async () => {
    let n = 0;
    setFetch(
      mockFetch({
        "POST https://api.openai.com/v1/responses": () =>
          ++n === 1
            ? jsonResponse({ error: { message: "tool not allowed" } }, 400)
            : sseResponse([{ type: "response.output_text.delta", delta: "ok" }, { type: "response.completed", response: { usage: {} } }]),
      }).impl,
    );
    const p = new OpenAIProvider();
    const conv = await p.createConversation(key("sk-x"), { model: "gpt-6.1", system: "s" });
    const chunks = await collect(p.streamMessage(key("sk-x"), conv, "hi", { webSearch: true }));
    expect(chunks.some((c) => c.type === "tool" && c.status === "failed")).toBe(true);
    expect(chunks.at(-1)).toMatchObject({ type: "done", text: "ok" });
  });
});

describe("AnthropicProvider (official SDK over our fetch)", () => {
  const sse = (events: [string, unknown][]) =>
    new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });

  it("streams Messages API text, uses fallbacks on supported models, and ignores ambient ANTHROPIC_* env", async () => {
    const m = mockFetch({
      "POST https://api.anthropic.com/v1/messages": () =>
        sse([
          ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 } } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Found 7 issues." } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }],
          ["message_stop", { type: "message_stop" }],
        ]),
    });
    setFetch(m.impl);
    const p = new AnthropicProvider();
    const conv = await p.createConversation(key("sk-ant-test"), { model: "claude-opus-5-5", system: "You review code." });
    const chunks = await collect(p.streamMessage(key("sk-ant-test"), conv, "Review this"));
    expect(chunks.at(-1)).toMatchObject({ type: "done", text: "Found 7 issues.", usage: { inputTokens: 20, outputTokens: 5 } });
    const call = m.calls[0]!;
    expect(call.url.startsWith("https://api.anthropic.com/v1/messages")).toBe(true);
    expect(call.headers["x-api-key"]).toBe("sk-ant-test");
    expect(call.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    const body = JSON.parse(call.body);
    expect(body).toMatchObject({ model: "claude-opus-5-5", system: "You review code.", stream: true, fallbacks: "default" });
  });

  it("surfaces refusals as errors instead of empty answers", async () => {
    setFetch(
      mockFetch({
        "POST https://api.anthropic.com/v1/messages": () =>
          sse([
            ["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
            ["message_delta", { type: "message_delta", delta: { stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" } }, usage: { output_tokens: 0 } }],
            ["message_stop", { type: "message_stop" }],
          ]),
      }).impl,
    );
    const p = new AnthropicProvider();
    const conv = await p.createConversation(key("sk-ant-x"), { model: "claude-opus-5-5", system: "s" });
    await expect(collect(p.streamMessage(key("sk-ant-x"), conv, "x"))).rejects.toThrow(/declined/);
  });

  it("rejects subscription sign-in", async () => {
    await expect(new AnthropicProvider().connect({ method: "sandbox" })).rejects.toThrow(/does not allow/);
  });
});

describe("GoogleProvider", () => {
  it("streams generateContent with an API key header and maps roles", async () => {
    const m = mockFetch({
      "POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent": () =>
        sseResponse([
          { candidates: [{ content: { parts: [{ text: "Independent " }] } }] },
          { candidates: [{ content: { parts: [{ text: "verdict", thought: false }, { text: "hidden", thought: true }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 }, modelVersion: "gemini-3-pro" },
        ]),
    });
    setFetch(m.impl);
    const p = new GoogleProvider();
    const conv = await p.createConversation(key("AIzaTEST"), { model: "gemini-3-pro", system: "judge" });
    conv.history.push({ role: "assistant", content: "earlier" });
    const chunks = await collect(p.streamMessage(key("AIzaTEST"), conv, "rule"));
    expect(chunks.at(-1)).toMatchObject({ type: "done", text: "Independent verdict", usage: { inputTokens: 9, outputTokens: 2 } });
    expect(m.calls[0]!.headers["x-goog-api-key"]).toBe("AIzaTEST");
    const body = JSON.parse(m.calls[0]!.body);
    expect(body.contents.map((c: any) => c.role)).toEqual(["model", "user"]);
    expect(body.systemInstruction.parts[0].text).toBe("judge");
  });

  it("uses Bearer + quota project for OAuth credentials", async () => {
    const m = mockFetch({ "GET https://generativelanguage.googleapis.com/v1beta/models": () => jsonResponse({ models: [] }) });
    setFetch(m.impl);
    await new GoogleProvider().healthCheck({ method: "oauth", accessToken: "ya29.token", scopes: [], extra: { quotaProject: "my-proj" } });
    expect(m.calls[0]!.headers.authorization).toBe("Bearer ya29.token");
    expect(m.calls[0]!.headers["x-goog-user-project"]).toBe("my-proj");
  });
});

describe("XAIProvider", () => {
  it("connects with an API key and streams via the xAI Responses API", async () => {
    const m = mockFetch({
      "GET https://api.x.ai/v1/models": () => jsonResponse({ data: [{ id: "grok-5" }, { id: "grok-5-mini" }, { id: "grok-imagine" }] }),
      "GET https://api.x.ai/v1/api-key": () => jsonResponse({ name: "my key", team_id: "t1" }),
      "POST https://api.x.ai/v1/responses": () =>
        sseResponse([{ type: "response.output_text.delta", delta: "news" }, { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }]),
    });
    setFetch(m.impl);
    const p = new XAIProvider();
    const out = await p.connect({ method: "api_key", apiKey: "xai-abcdefgh", fields: {} });
    expect(out.kind === "connected" && out.account.defaultModel).toBe("grok-5");
    const conv = await p.createConversation(key("xai-abcdefgh"), { model: "grok-5", system: "s" });
    const chunks = await collect(p.streamMessage(key("xai-abcdefgh"), conv, "what's new"));
    expect(chunks.at(-1)).toMatchObject({ type: "done", text: "news" });
  });

  it("refuses subscription OAuth until xAI documents it", async () => {
    await expect(new XAIProvider().connect({ method: "sandbox" })).rejects.toThrow(/not available/);
  });
});

describe("CursorProvider", () => {
  it("requires a repository", async () => {
    const p = new CursorProvider();
    const conv = await p.createConversation(key("crsr_x"), { system: "s" });
    await expect(collect(p.streamMessage(key("crsr_x"), conv, "fix it"))).rejects.toThrow(/repository/);
  });

  it("creates a Cloud Agent without auto-PR, polls to completion, and supports follow-ups", async () => {
    cursorTiming.pollMs = 1;
    let polls = 0;
    const m = mockFetch({
      "POST https://api.cursor.com/v1/agents": () => jsonResponse({ agent: { id: "bc-1", latestRunId: "run-1" } }),
      "GET https://api.cursor.com/v1/agents/bc-1/runs/run-1": () =>
        jsonResponse(
          ++polls < 3
            ? { id: "run-1", status: "RUNNING" }
            : { id: "run-1", status: "FINISHED", result: "Fixed the null check.", git: { branches: [{ branch: "cursor/fix" }] } },
        ),
      "POST https://api.cursor.com/v1/agents/bc-1/runs": () => jsonResponse({ run: { id: "run-2" } }),
      "GET https://api.cursor.com/v1/agents/bc-1/runs/run-2": () => jsonResponse({ id: "run-2", status: "FINISHED", result: "Added a test." }),
    });
    setFetch(m.impl);
    const p = new CursorProvider();
    const conv = await p.createConversation(key("crsr_x"), { system: "You are the coding agent." });
    const chunks = await collect(p.streamMessage(key("crsr_x"), conv, "fix the bug", { repoUrl: "https://github.com/o/r" }));
    expect((chunks.at(-1) as any).text).toContain("Fixed the null check.");
    expect((chunks.at(-1) as any).text).toContain("cursor/fix");
    const created = JSON.parse(m.calls[0]!.body);
    expect(created).toMatchObject({ autoCreatePR: false, repos: [{ url: "https://github.com/o/r" }] });
    expect(m.calls[0]!.headers.authorization).toBe("Bearer crsr_x");

    const again = await collect(p.streamMessage(key("crsr_x"), conv, "add a test", { repoUrl: "https://github.com/o/r" }));
    expect((again.at(-1) as any).text).toBe("Added a test.");
  });
});
