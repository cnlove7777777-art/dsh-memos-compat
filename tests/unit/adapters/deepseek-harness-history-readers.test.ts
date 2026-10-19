import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  HISTORY_DECOMPRESSED_LIMIT,
  parseCodexHistory,
  parseDshHistory,
  readHistoryFile,
} from "../../../adapters/deepseek-harness/history-readers.js";

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
});

async function tempFile(name: string, content: string | Buffer): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "memos-history-"));
  homes.push(home);
  const path = join(home, name);
  await writeFile(path, content);
  return path;
}

function codexLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function dshLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function codexMessage(role: string, content: unknown, phase?: string): unknown {
  return {
    timestamp: "2026-01-02T03:04:05.000Z",
    type: "response_item",
    payload: {
      type: "message",
      id: `msg-${role}-${phase ?? "input"}`,
      role,
      ...(phase ? { phase } : {}),
      content,
    },
  };
}

describe("Codex history reader", () => {
  it("keeps only direct user turns completed by final answers", () => {
    const text = [
      codexLine({
        type: "session_meta",
        payload: {
          id: "session-codex-synthetic",
          cwd: "/synthetic/project",
          timestamp: "2026-01-02T03:00:00.000Z",
        },
      }),
      codexLine(codexMessage("developer", [
        { type: "input_text", text: "system instructions" },
      ])),
      codexLine(codexMessage("user", [
        { type: "input_text", text: "# AGENTS.md instructions for /synthetic\nmust skip" },
      ])),
      codexLine(codexMessage("user", [
        { type: "input_text", text: "first direct question" },
      ])),
      codexLine(codexMessage("assistant", [
        { type: "output_text", text: "progress only" },
      ], "commentary")),
      codexLine(codexMessage("assistant", [
        { type: "output_text", text: "first final answer" },
      ], "final_answer")),
      codexLine(codexMessage("user", [
        { type: "input_text", text: "in-flight question" },
      ])),
      "{this is a malformed row}\n",
      codexLine(codexMessage("assistant", [
        { type: "output_text", text: "not complete yet" },
      ], "commentary")),
      "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\"",
    ].join("");

    const turns = parseCodexHistory(text, "/synthetic/codex.jsonl");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      source: "codex",
      sessionId: "session-codex-synthetic",
      userText: "first direct question",
      agentText: "first final answer",
      cwd: "/synthetic/project",
    });
    expect(turns[0].ts).toBe(Date.parse("2026-01-02T03:04:05.000Z"));
    expect(turns[0].sourceRef).toMatch(/codex\.jsonl:6$/);
    expect(turns[0].turnKey).toMatch(/^codex:session-codex-synthetic:\d+:[0-9a-f]{16}$/);
  });

  it("excludes a delegated child even when it contains user/final rows", () => {
    const text = [
      codexLine({
        type: "session_meta",
        payload: {
          id: "synthetic-child",
          session_id: "synthetic-parent",
          thread_source: "subagent",
          parent_thread_id: "synthetic-parent",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "synthetic-parent",
                depth: 1,
                agent_path: null,
                agent_nickname: "Synthetic",
                agent_role: null,
              },
            },
          },
          cwd: "/synthetic",
        },
      }),
      codexLine(codexMessage("user", [
        { type: "input_text", text: "delegated child task" },
      ])),
      codexLine(codexMessage("assistant", [
        { type: "output_text", text: "delegated child final" },
      ], "final_answer")),
    ].join("");
    expect(parseCodexHistory(text, "/synthetic/rollout-child.jsonl")).toEqual([]);
  });

  it("excludes the conservative string source=subagent form", () => {
    const text = [
      codexLine({
        type: "session_meta",
        payload: {
          id: "synthetic-conservative-child",
          source: "subagent",
        },
      }),
      codexLine(codexMessage("user", [
        { type: "input_text", text: "delegated prompt" },
      ])),
      codexLine(codexMessage("assistant", [
        { type: "output_text", text: "delegated final" },
      ], "final_answer")),
    ].join("");
    expect(parseCodexHistory(text, "/synthetic/rollout-string-child.jsonl")).toEqual([]);
  });

  it("keeps an ordinary source object that is not a child session", () => {
    const text = [
      codexLine({
        type: "session_meta",
        payload: {
          id: "synthetic-ordinary-object",
          thread_source: "user",
          source: {
            client: "vscode",
            workspace: "/synthetic",
          },
        },
      }),
      codexLine(codexMessage("user", [
        { type: "input_text", text: "ordinary prompt" },
      ])),
      codexLine(codexMessage("assistant", [
        { type: "output_text", text: "ordinary final" },
      ], "final_answer")),
    ].join("");
    expect(parseCodexHistory(text, "/synthetic/rollout-ordinary.jsonl")).toHaveLength(1);
  });

  it("supports legacy event_msg without duplicating response_item messages", () => {
    const text = [
      codexLine({
        type: "session_meta",
        payload: { id: "legacy-session", cwd: "/legacy" },
      }),
      codexLine({
        type: "response_item",
        payload: {
          type: "message",
          id: "user-1",
          role: "user",
          content: [{ type: "input_text", text: "legacy prompt" }],
        },
      }),
      codexLine({
        type: "event_msg",
        payload: { type: "user_message", message: "legacy prompt" },
      }),
      codexLine({
        type: "event_msg",
        payload: { type: "agent_message", message: "legacy final" },
      }),
      codexLine({
        type: "event_msg",
        payload: { type: "agent_message", message: "legacy final" },
      }),
    ].join("");

    const turns = parseCodexHistory(text, "/legacy/rollout.jsonl");
    expect(turns).toHaveLength(1);
    expect(turns[0].userText).toBe("legacy prompt");
    expect(turns[0].agentText).toBe("legacy final");
  });

  it("does not re-import a final answer mirrored by event_msg", () => {
    const text = [
      codexLine({
        type: "response_item",
        payload: {
          type: "message",
          id: "u1",
          role: "user",
          content: [{ type: "input_text", text: "mirrored prompt" }],
        },
      }),
      codexLine({
        type: "response_item",
        payload: {
          type: "message",
          id: "a1",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "mirrored final" }],
        },
      }),
      codexLine({
        type: "event_msg",
        payload: { type: "user_message", message: "mirrored prompt" },
      }),
      codexLine({
        type: "event_msg",
        payload: { type: "agent_message", message: "mirrored final" },
      }),
    ].join("");
    expect(parseCodexHistory(text, "/synthetic/mirror.jsonl")).toHaveLength(1);
  });

  it("pairs repeated prompts by position instead of collapsing them", () => {
    const text = [
      codexLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "repeat" }],
        },
      }),
      codexLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "first" }],
        },
      }),
      codexLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "repeat" }],
        },
      }),
      codexLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "second" }],
        },
      }),
    ].join("");
    const turns = parseCodexHistory(text, "/synthetic/repeated.jsonl");
    expect(turns.map((turn) => turn.agentText)).toEqual(["first", "second"]);
    expect(new Set(turns.map((turn) => turn.turnKey)).size).toBe(2);
  });

  it("derives a stable turn key from source position and text", () => {
    const text = [
      codexLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "same prompt" }],
        },
      }),
      codexLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "answer" }],
        },
      }),
    ].join("");
    const path = "/synthetic/rollout-00000000-0000-0000-0000-000000000000.jsonl";
    expect(parseCodexHistory(text, path)[0].turnKey).toBe(
      parseCodexHistory(text, path)[0].turnKey,
    );
  });

  it("ignores ambient and tool-shaped user rows", () => {
    const text = [
      codexLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<environment_context>ambient</environment_context>" }],
        },
      }),
      codexLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<external_codex_apps_open_page>{\"page_id\":null}</external_codex_apps_open_page>" }],
        },
      }),
      codexLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "direct" }],
        },
      }),
      codexLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "answer" }],
        },
      }),
    ].join("");
    expect(parseCodexHistory(text, "/synthetic/rollout.jsonl")).toHaveLength(1);
  });

  it("strips control wrappers while retaining an explicit human request", () => {
    const text = [
      codexLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: "<in-app-browser-context>synthetic page</in-app-browser-context>\n## My request\nPlease inspect the synthetic page.",
          }],
        },
      }),
      codexLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "synthetic answer" }],
        },
      }),
    ].join("");
    const turns = parseCodexHistory(text, "/synthetic/wrapped.jsonl");
    expect(turns).toHaveLength(1);
    expect(turns[0].userText).toContain("## My request");
    expect(turns[0].userText).toContain("Please inspect the synthetic page.");
  });

  it("rejects control-only wrappers and compaction continuations", () => {
    const text = [
      codexLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: "<in-app-browser-context>synthetic page</in-app-browser-context>",
          }],
        },
      }),
      codexLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: "Another language model started to solve this problem and produced a summary.",
          }],
        },
      }),
      codexLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: "<subagent_notification>synthetic child status</subagent_notification>",
          }],
        },
      }),
      codexLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: "<send_user_message_question_reply>synthetic reply</send_user_message_question_reply>",
          }],
        },
      }),
    ].join("");
    expect(parseCodexHistory(text, "/synthetic/controls.jsonl")).toEqual([]);
  });

  it.each([
    "<subagent_notification>synthetic status</subagent_notification>",
    "<subagent_notification>truncated synthetic status",
    "<in-app-browser-context>synthetic page</in-app-browser-context>",
    "<send_user_message_question_reply>synthetic reply</send_user_message_question_reply>",
  ])("does not pair a control-only message with the next assistant answer: %s", (message) => {
    for (const event of [false, true]) {
      const text = [
        codexLine({ type: "session_meta", payload: { id: "synthetic-session", source: "cli" } }),
        codexLine(event
          ? { type: "event_msg", payload: { type: "user_message", message } }
          : { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: message }] } }),
        codexLine(event
          ? { type: "event_msg", payload: { type: "agent_message", message: "Synthetic answer" } }
          : { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Synthetic answer" }] } }),
      ].join("");
      expect(parseCodexHistory(text, "/synthetic/controls-with-answer.jsonl")).toEqual([]);
    }
  });

  it("retains a real human request after a control wrapper", () => {
    const text = [
      codexLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: "<subagent_notification>synthetic status</subagent_notification>\nPlease inspect the parent result.",
          }],
        },
      }),
      codexLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "synthetic answer" }],
        },
      }),
    ].join("");
    const turns = parseCodexHistory(text, "/synthetic/wrapped-subagent.jsonl");
    expect(turns).toHaveLength(1);
    expect(turns[0].userText).toBe("Please inspect the parent result.");
  });
});

describe("DSH V4 history reader", () => {
  it("uses completed turn/end and the final text-only assistant message", () => {
    const text = [
      dshLine({
        type: "session",
        version: 4,
        id: "session-dsh-synthetic",
        cwd: "/synthetic/dsh",
        isSeeded: false,
        delegationDepth: 0,
      }),
      dshLine({ type: "turn/start", seq: 1, time: 1000, data: { turn: 1 } }),
      dshLine({
        type: "user/message",
        seq: 2,
        time: 1001,
        data: {
          id: "u1",
          role: "user",
          source: { kind: "user" },
          content: [{ type: "text", text: "direct question" }],
        },
      }),
      dshLine({
        type: "user/message",
        seq: 3,
        time: 1002,
        data: {
          id: "u2",
          role: "user",
          source: { kind: "runtime-context" },
          content: [{ type: "text", text: "ambient context" }],
        },
      }),
      dshLine({
        type: "assistant/message",
        seq: 4,
        time: 1003,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: "assistant",
            source: { kind: "model" },
            content: [
              { type: "reasoning", text: "hidden reasoning" },
              { type: "text", text: "working on it" },
              { type: "tool-call", name: "read", arguments: "{}" },
            ],
          },
        },
      }),
      dshLine({
        type: "assistant/message",
        seq: 5,
        time: 1004,
        data: {
          turn: 1,
          step: 2,
          message: {
            role: "assistant",
            source: { kind: "model" },
            content: [
              { type: "reasoning", text: "hidden final reasoning" },
              { type: "text", text: "final synthetic answer" },
            ],
          },
        },
      }),
      dshLine({
        type: "turn/end",
        seq: 6,
        time: 1005,
        data: { turn: 1, reason: { kind: "completed" } },
      }),
      dshLine({ type: "turn/start", seq: 7, time: 2000, data: { turn: 2 } }),
      dshLine({
        type: "user/message",
        seq: 8,
        time: 2001,
        data: {
          id: "u3",
          role: "user",
          source: { kind: "user" },
          content: [{ type: "text", text: "in flight" }],
        },
      }),
    ].join("");

    const turns = parseDshHistory(text, "/synthetic/session.v4.jsonl.zstd");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      source: "dsh",
      sessionId: "session-dsh-synthetic",
      userText: "direct question",
      agentText: "final synthetic answer",
      ts: 1004000,
      cwd: "/synthetic/dsh",
    });
    expect(turns[0].sourceRef).toMatch(/session\.v4\.jsonl\.zstd:6$/);
  });

  it("skips seeded and delegated sessions and plugin/tool messages", () => {
    const seeded = [
      dshLine({
        type: "session",
        version: 4,
        id: "seeded-session",
        isSeeded: true,
        delegationDepth: 0,
      }),
      dshLine({ type: "turn/start", seq: 1, time: 1, data: { turn: 1 } }),
      dshLine({
        type: "user/message",
        seq: 2,
        time: 2,
        data: {
          id: "u",
          role: "user",
          source: { kind: "user" },
          content: [{ type: "text", text: "inherited prompt" }],
        },
      }),
      dshLine({
        type: "assistant/message",
        seq: 3,
        time: 3,
        data: {
          turn: 1,
          message: { content: [{ type: "text", text: "inherited answer" }] },
        },
      }),
      dshLine({
        type: "turn/end",
        seq: 4,
        time: 4,
        data: { turn: 1, reason: { kind: "completed" } },
      }),
    ].join("");
    expect(parseDshHistory(seeded, "/synthetic/seeded/session.v4.jsonl.zstd")).toEqual([]);

    const delegated = seeded
      .replace('"seeded-session"', '"child-session"')
      .replace('"isSeeded":true', '"isSeeded":false')
      .replace('"delegationDepth":0', '"delegationDepth":1');
    expect(parseDshHistory(delegated, "/synthetic/child/session.v4.jsonl.zstd")).toEqual([]);
  });
});

describe("bounded history file reader", () => {
  it("reads synthetic Codex JSONL from disk", async () => {
    const text = [
      codexLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "disk prompt" }],
        },
      }),
      codexLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "disk answer" }],
        },
      }),
    ].join("");
    const path = await tempFile("rollout.jsonl", text);
    await expect(readHistoryFile(path, "codex")).resolves.toEqual([
      expect.objectContaining({ userText: "disk prompt", agentText: "disk answer" }),
    ]);
  });

  it("reads multi-frame zstd JSONL with the Node zstd decoder", async () => {
    const first = dshLine({
      type: "session",
      version: 4,
      id: "zstd-session",
      isSeeded: false,
      delegationDepth: 0,
    });
    const second = [
      dshLine({ type: "turn/start", seq: 1, time: 1, data: { turn: 1 } }),
      dshLine({
        type: "user/message",
        seq: 2,
        time: 2,
        data: {
          id: "u",
          role: "user",
          source: { kind: "user" },
          content: [{ type: "text", text: "zstd prompt" }],
        },
      }),
      dshLine({
        type: "assistant/message",
        seq: 3,
        time: 3,
        data: {
          turn: 1,
          message: { content: [{ type: "text", text: "zstd answer" }] },
        },
      }),
      dshLine({
        type: "turn/end",
        seq: 4,
        time: 4,
        data: { turn: 1, reason: { kind: "completed" } },
      }),
    ].join("");
    const path = await tempFile(
      "session.v4.jsonl.zstd",
      Buffer.concat([
        zstdCompressSync(Buffer.from(first)),
        zstdCompressSync(Buffer.from(second)),
      ]),
    );
    await expect(readHistoryFile(path, "dsh")).resolves.toEqual([
      expect.objectContaining({ userText: "zstd prompt", agentText: "zstd answer" }),
    ]);
  });

  it("guards decompressed output before unbounded expansion", async () => {
    const path = await tempFile(
      "session.v4.jsonl.zstd",
      zstdCompressSync(Buffer.alloc(HISTORY_DECOMPRESSED_LIMIT + 1, 0x20)),
    );
    await expect(readHistoryFile(path, "dsh")).rejects.toThrow(/128 MiB/);
  });

  it("reads a valid single-frame stream and rejects a non-zstd file", async () => {
    const path = await tempFile(
      "session.v4.jsonl.zstd",
      zstdCompressSync(Buffer.from("{\"type\":\"session\"}\n")),
    );
    await expect(readHistoryFile(path, "dsh")).resolves.toEqual([]);
    const invalid = await tempFile("invalid.v4.jsonl.zstd", Buffer.from("not zstd"));
    await expect(readHistoryFile(invalid, "dsh")).rejects.toThrow(/zstd|ZSTD|frame/i);
  });

  it("rejects input over the 64 MiB compressed-file limit", async () => {
    const path = await tempFile(
      "session.v4.jsonl.zstd",
      Buffer.alloc(64 * 1024 * 1024 + 1, 0),
    );
    await expect(readHistoryFile(path, "dsh")).rejects.toThrow(/64 MiB/);
  });
});
