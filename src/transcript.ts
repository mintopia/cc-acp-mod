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

type Entry = {
  type?: string;
  cwd?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  customTitle?: string;
  aiTitle?: string;
  message?: { content?: unknown };
};

function* entries(jsonl: string): Generator<Entry> {
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as Entry;
    } catch {}
  }
}

function blocksOf(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
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

  for (const entry of entries(jsonl)) {
    if ((entry.type !== "user" && entry.type !== "assistant") || entry.isMeta || entry.isSidechain) continue;
    for (const block of blocksOf(entry.message?.content)) {
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

export const SESSION_PAGE_SIZE = 50;

interface Listed {
  info: acp.SessionInfo;
  mtime: number;
}

function firstUserText(content: unknown): string | undefined {
  for (const block of blocksOf(content)) {
    if (block.type !== "text" || typeof block.text !== "string") continue;
    const visible = block.text.replace(HIDDEN_MARKERS, "").trim();
    if (visible) return visible;
  }
  return undefined;
}

export function summariseTranscript(jsonl: string): { cwd?: string; title?: string } {
  let cwd: string | undefined;
  let named: string | undefined;
  let firstPrompt: string | undefined;
  for (const entry of entries(jsonl)) {
    if (!cwd && typeof entry.cwd === "string") cwd = entry.cwd;
    if (entry.type === "custom-title" && entry.customTitle) named = entry.customTitle;
    else if (entry.type === "ai-title" && entry.aiTitle && !named) named = entry.aiTitle;
    else if (!firstPrompt && entry.type === "user" && !entry.isMeta && !entry.isSidechain) firstPrompt = firstUserText(entry.message?.content);
  }
  const title = named ?? firstPrompt?.replace(/\s+/g, " ").slice(0, 100);
  return { cwd, title };
}

export async function listTranscripts(
  opts: { cwd?: string | null; cursor?: string | null; pageSize?: number },
  env: NodeJS.ProcessEnv = process.env,
): Promise<acp.ListSessionsResponse> {
  const root = claudeProjectsDir(env);
  const projects = await readdir(root).catch(() => [] as string[]);
  const found: Listed[] = [];
  for (const project of projects) {
    const files = await readdir(join(root, project)).catch(() => [] as string[]);
    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(root, project, name);
      const info = await stat(file).catch(() => undefined);
      if (!info?.isFile()) continue;
      const { cwd, title } = summariseTranscript(await readFile(file, "utf8").catch(() => ""));
      if (!cwd || (opts.cwd && cwd !== opts.cwd)) continue;
      found.push({
        mtime: info.mtimeMs,
        info: { sessionId: name.slice(0, -".jsonl".length), cwd, title: title ?? null, updatedAt: info.mtime.toISOString() },
      });
    }
  }
  found.sort((a, b) => b.mtime - a.mtime || a.info.sessionId.localeCompare(b.info.sessionId));
  const start = Math.max(0, Number.parseInt(opts.cursor ?? "0", 10) || 0);
  const size = opts.pageSize ?? SESSION_PAGE_SIZE;
  const page = found.slice(start, start + size).map((f) => f.info);
  return { sessions: page, ...(start + size < found.length ? { nextCursor: String(start + size) } : {}) };
}
