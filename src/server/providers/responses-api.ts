import { parseSSE, providerFetch, toProviderError, withTimeout } from "./http";
import { ProviderError, type ProviderConversation, type SendOptions, type StreamChunk } from "./types";

/** The subset of Responses API stream events we consume. */
type ResponsesEvent = {
  type?: string;
  delta?: unknown;
  message?: string;
  error?: { message?: string };
  response?: {
    model?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  };
};

/**
 * Streams an OpenAI-style Responses API call (`POST {baseUrl}/responses`).
 * Used by OpenAI (API key and Sign in with ChatGPT tokens) and xAI.
 */
export async function* streamResponses(args: {
  provider: string;
  baseUrl: string;
  token: string;
  headers?: Record<string, string>;
  conversation: ProviderConversation;
  message: string;
  opts?: SendOptions;
  webSearchTool?: Record<string, unknown> | null;
  store?: boolean;
}): AsyncGenerator<StreamChunk> {
  const { conversation, message, opts } = args;
  const input = [...conversation.history, { role: "user" as const, content: message }].map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const body: Record<string, unknown> = {
    model: conversation.model,
    instructions: conversation.system,
    input,
    stream: true,
    store: args.store ?? false,
  };
  if (opts?.maxOutputTokens) body.max_output_tokens = opts.maxOutputTokens;
  if (opts?.webSearch && args.webSearchTool) body.tools = [args.webSearchTool];

  const send = (payload: Record<string, unknown>) =>
    providerFetch(`${args.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${args.token}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        ...args.headers,
      },
      body: JSON.stringify(payload),
      signal: withTimeout(opts?.signal, 10 * 60_000),
    });

  let res = await send(body);
  // If the account can't use the search tool, degrade gracefully rather than failing the agent.
  if (res.status === 400 && body.tools) {
    delete body.tools;
    yield { type: "tool", name: "web_search", status: "failed", detail: "Web search unavailable for this account" };
    res = await send(body);
  }
  if (!res.ok) throw await toProviderError(args.provider, res);

  let text = "";
  let usage = { inputTokens: 0, outputTokens: 0 };
  let model = conversation.model;
  let finished = false;

  for await (const ev of parseSSE(res.body)) {
    if (ev.data === "[DONE]") break;
    let data: ResponsesEvent;
    try {
      data = JSON.parse(ev.data);
    } catch {
      continue;
    }
    const type = data.type ?? ev.event ?? "";
    if (type === "response.output_text.delta" && typeof data.delta === "string") {
      text += data.delta;
      yield { type: "delta", text: data.delta };
    } else if (type.startsWith("response.web_search_call.")) {
      if (type.endsWith("in_progress")) yield { type: "tool", name: "web_search", status: "started" };
      if (type.endsWith("completed")) yield { type: "tool", name: "web_search", status: "completed" };
    } else if (type === "response.completed" || type === "response.incomplete") {
      const r = data.response ?? {};
      usage = { inputTokens: r.usage?.input_tokens ?? 0, outputTokens: r.usage?.output_tokens ?? 0 };
      model = r.model ?? model;
      finished = true;
    } else if (type === "response.failed" || type === "error") {
      const msg = data.response?.error?.message ?? data.error?.message ?? data.message ?? "Response failed";
      throw new ProviderError(args.provider, null, `${args.provider}: ${msg}`);
    }
  }
  if (!finished && !text) throw new ProviderError(args.provider, null, `${args.provider} stream ended unexpectedly`, true);

  conversation.history.push({ role: "user", content: message }, { role: "assistant", content: text });
  yield { type: "done", text, usage, model };
}
