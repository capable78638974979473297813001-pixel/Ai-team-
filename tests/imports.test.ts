import { describe, expect, it } from "vitest";
import { parseChatGPTExport, parseClaudeExport, parsePastedText } from "@/server/services/imports";

describe("conversation import", () => {
  it("parses pasted transcripts with speaker labels", () => {
    const c = parsePastedText("User: How do I scale?\nmore detail\nChatGPT: Use replicas.\n\nYou: thanks");
    expect(c.turns).toEqual([
      { speaker: "You", text: "How do I scale?\nmore detail" },
      { speaker: "ChatGPT", text: "Use replicas." },
      { speaker: "You", text: "thanks" },
    ]);
    expect(c.title).toBe("How do I scale?");
  });

  it("follows the current branch of a ChatGPT export", () => {
    const exp = [
      {
        title: "Scaling",
        current_node: "c",
        mapping: {
          root: { message: null, parent: null },
          a: { message: { author: { role: "user" }, content: { parts: ["Q1"] } }, parent: "root" },
          b: { message: { author: { role: "assistant" }, content: { parts: ["A1"] } }, parent: "a" },
          stale: { message: { author: { role: "assistant" }, content: { parts: ["old"] } }, parent: "a" },
          c: { message: { author: { role: "user" }, content: { parts: ["Q2"] } }, parent: "b" },
        },
      },
    ];
    const [c] = parseChatGPTExport(exp);
    expect(c!.turns.map((t) => t.text)).toEqual(["Q1", "A1", "Q2"]);
  });

  it("parses a Claude export", () => {
    const [c] = parseClaudeExport([{ name: "Plan", chat_messages: [{ sender: "human", text: "hi" }, { sender: "assistant", text: "hello" }] }]);
    expect(c!.turns).toEqual([
      { speaker: "You", text: "hi" },
      { speaker: "Claude", text: "hello" },
    ]);
  });

  it("ignores malformed exports", () => {
    expect(parseChatGPTExport({ nope: true })).toEqual([]);
    expect(parseClaudeExport("x")).toEqual([]);
  });
});
