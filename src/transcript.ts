import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { claudeProjectsDir } from "./paths.js";
import { diffContent, toolInfo } from "./tool-mapping.js";

type Update = acp.SessionNotification["update"];

const HIDDEN_MARKERS = /<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>[\s\S]*?<\/\1>/g;

export async function findTranscript(sessionId: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const root = claudeProjectsDir(env);
  let projects: string[];
  try {
    projects = await readdir(root);
  } catch {
    return undefined;
  }
  for (const project of projects) {
    const file = join(root, project, `${sessionId}.jsonl`);
    if (await stat(file).then((s) => s.isFile(), () => false)) return file;
  }
  return undefined;
}

export async function readTranscript(sessionId: string, env: NodeJS.ProcessEnv = process.env): Promise<Update[]> {
  const file = await findTranscript(sessionId, env);
  return file ? replayUpdates(await readFile(file, "utf8")) : [];
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("");
}

export function replayUpdates(jsonl: string): Update[] {
  const updates: Update[] = [];
  const text = (sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk", value: string) =>
    updates.push({ sessionUpdate, content: { type: "text", text: value } });

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: { type?: string; isMeta?: boolean; isSidechain?: boolean; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if ((entry.type !== "user" && entry.type !== "assistant") || entry.isMeta || entry.isSidechain) continue;
    const content = entry.message?.content;
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    for (const block of blocks as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") {
        const visible = entry.type === "user" ? block.text.replace(HIDDEN_MARKERS, "").trim() : block.text;
        if (visible) text(entry.type === "user" ? "user_message_chunk" : "agent_message_chunk", visible);
      } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
        text("agent_thought_chunk", block.thinking);
      } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        const input = (block.input ?? {}) as Record<string, unknown>;
        const diff = diffContent(block.name, input);
        updates.push({
          sessionUpdate: "tool_call",
          toolCallId: block.id,
          status: "pending",
          rawInput: input,
          _meta: { claudeCode: { toolName: block.name } },
          ...(diff ? { content: diff } : {}),
          ...toolInfo(block.name, input),
        });
      } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        const output = resultText(block.content);
        updates.push({
          sessionUpdate: "tool_call_update",
          toolCallId: block.tool_use_id,
          status: block.is_error === true ? "failed" : "completed",
          ...(output ? { content: [{ type: "content", content: { type: "text", text: output } }] } : {}),
        });
      }
    }
  }
  return updates;
}
