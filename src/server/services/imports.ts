import { db } from "../db/client";
import { messages } from "../db/schema";
import { createTask } from "./tasks";

/**
 * Conversation import. Only user-provided material is accepted: pasted text or
 * files the user exported with the provider's own official export feature.
 * OAuth grants do NOT give us access to a user's provider chat history, and
 * we never fetch it by other means.
 */
export type ImportSourceInfo = { id: string; label: string; availability: "available" | "coming_soon"; description: string };

export const IMPORT_SOURCES: ImportSourceInfo[] = [
  { id: "text", label: "Paste a conversation", availability: "available", description: "Paste text copied from any AI chat." },
  {
    id: "chatgpt_export",
    label: "ChatGPT data export",
    availability: "available",
    description: "conversations.json from ChatGPT → Settings → Data controls → Export data.",
  },
  {
    id: "claude_export",
    label: "Claude data export",
    availability: "available",
    description: "conversations.json from Claude → Settings → Privacy → Export data.",
  },
  {
    id: "share_link",
    label: "Share links",
    availability: "coming_soon",
    description: "Needs an official provider API for reading shared conversations.",
  },
  {
    id: "provider_api",
    label: "Import from provider account",
    availability: "coming_soon",
    description: "No provider currently offers third-party apps an official history import API.",
  },
];

export type ImportedTurn = { speaker: string; text: string };
export type ImportedConversation = { title: string; turns: ImportedTurn[] };

const SPEAKER = /^\s*(user|you|me|human|assistant|ai|chatgpt|gpt|claude|gemini|grok|bard|copilot)\s*[:：]\s*/i;

export function parsePastedText(text: string, title?: string): ImportedConversation {
  const turns: ImportedTurn[] = [];
  let current: ImportedTurn | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(SPEAKER);
    if (m) {
      if (current?.text.trim()) turns.push(current);
      current = { speaker: normaliseSpeaker(m[1]!), text: line.slice(m[0].length) };
    } else if (current) {
      current.text += `\n${line}`;
    } else if (line.trim()) {
      current = { speaker: "Unknown", text: line };
    }
  }
  if (current?.text.trim()) turns.push(current);
  const cleaned = turns.map((t) => ({ ...t, text: t.text.trim() })).filter((t) => t.text);
  return { title: title?.trim() || firstLine(cleaned[0]?.text ?? "Imported conversation"), turns: cleaned };
}

function normaliseSpeaker(s: string) {
  const l = s.toLowerCase();
  if (["user", "you", "me", "human"].includes(l)) return "You";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function firstLine(s: string) {
  const l = s.split("\n")[0]!.trim();
  return l.length > 60 ? `${l.slice(0, 59)}…` : l;
}

type ChatGPTNode = {
  message?: { author?: { role?: string }; content?: { content_type?: string; parts?: unknown[] } } | null;
  parent?: string | null;
};

export function parseChatGPTExport(json: unknown): ImportedConversation[] {
  const list = Array.isArray(json) ? json : [json];
  const out: ImportedConversation[] = [];
  for (const conv of list.slice(0, 50)) {
    if (!conv || typeof conv !== "object") continue;
    const c = conv as { title?: string; mapping?: Record<string, ChatGPTNode>; current_node?: string };
    if (!c.mapping) continue;
    const chain: ChatGPTNode[] = [];
    let id: string | null | undefined = c.current_node;
    const seen = new Set<string>();
    while (id && c.mapping[id] && !seen.has(id)) {
      seen.add(id);
      chain.push(c.mapping[id]!);
      id = c.mapping[id]!.parent;
    }
    const turns = chain
      .reverse()
      .map((n) => {
        const role = n.message?.author?.role;
        const parts = (n.message?.content?.parts ?? []).filter((p): p is string => typeof p === "string");
        return role === "user" || role === "assistant" ? { speaker: role === "user" ? "You" : "ChatGPT", text: parts.join("\n").trim() } : null;
      })
      .filter((t): t is ImportedTurn => !!t && !!t.text);
    if (turns.length) out.push({ title: c.title || "ChatGPT conversation", turns });
  }
  return out;
}

export function parseClaudeExport(json: unknown): ImportedConversation[] {
  const list = Array.isArray(json) ? json : [json];
  const out: ImportedConversation[] = [];
  for (const conv of list.slice(0, 50)) {
    const c = conv as { name?: string; chat_messages?: { sender?: string; text?: string; content?: { type?: string; text?: string }[] }[] };
    if (!c?.chat_messages) continue;
    const turns = c.chat_messages
      .map((m) => ({
        speaker: m.sender === "human" ? "You" : "Claude",
        text: (m.text || (m.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n") || "").trim(),
      }))
      .filter((t) => t.text);
    if (turns.length) out.push({ title: c.name || "Claude conversation", turns });
  }
  return out;
}

export async function saveImported(userId: string, convs: ImportedConversation[]) {
  const ids: string[] = [];
  for (const conv of convs.slice(0, 50)) {
    const turns = conv.turns.slice(0, 500).map((t) => ({ ...t, text: t.text.slice(0, 20_000) }));
    const task = await createTask(userId, conv.title, null, "import", conv.title.slice(0, 120));
    await db()
      .insert(messages)
      .values(
        turns.map((t) => ({
          taskId: task.id,
          authorType: t.speaker === "You" ? "user" : "system",
          kind: "imported",
          content: `${t.speaker}: ${t.text}`,
          metadata: { speaker: t.speaker, imported: true },
        })),
      );
    ids.push(task.id);
  }
  return ids;
}
