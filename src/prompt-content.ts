import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { socketDir } from "./paths.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as acp from "@agentclientprotocol/sdk";

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

export interface AttachmentDir {
  ensure(): Promise<string>;
}

export class SessionAttachments implements AttachmentDir {
  private dir?: string;

  constructor(
    private readonly sessionId: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async ensure(): Promise<string> {
    this.dir ??= join(socketDir(this.env), `${this.sessionId}-attachments`);
    return this.dir;
  }

  async cleanup(): Promise<void> {
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
    this.dir = undefined;
  }
}

async function saveFile(dir: AttachmentDir, mimeType: string | undefined, bytes: Buffer): Promise<string> {
  const base = await dir.ensure();
  await mkdir(base, { recursive: true });
  const path = join(base, `attachment-${randomUUID()}.${EXTENSIONS[mimeType ?? ""] ?? "bin"}`);
  await writeFile(path, bytes);
  return path;
}

async function imageText(block: acp.ImageContent, dir: AttachmentDir): Promise<string> {
  if (block.data) return `[Image attached: ${await saveFile(dir, block.mimeType, Buffer.from(block.data, "base64"))}]`;
  if (block.uri?.startsWith("file:")) return `[Image attached: ${fileURLToPath(block.uri)}]`;
  if (block.uri && /^https?:/.test(block.uri)) {
    const res = await fetch(block.uri);
    if (!res.ok) throw new Error(`Failed to fetch image ${block.uri}: ${res.status}`);
    const mimeType = res.headers.get("content-type")?.split(";")[0] || block.mimeType;
    return `[Image attached: ${await saveFile(dir, mimeType, Buffer.from(await res.arrayBuffer()))}]`;
  }
  return `[Image unavailable: ${block.uri ?? "no data"}]`;
}

async function blockText(block: acp.ContentBlock, dir: AttachmentDir): Promise<string> {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      return imageText(block, dir);
    case "resource_link":
      return `[Resource: ${block.name} (${block.uri.startsWith("file:") ? fileURLToPath(block.uri) : block.uri})]`;
    case "resource": {
      const r = block.resource;
      if ("text" in r) return `<resource uri="${r.uri}">\n${r.text}\n</resource>`;
      return `[Resource ${r.uri} saved to: ${await saveFile(dir, r.mimeType ?? undefined, Buffer.from(r.blob, "base64"))}]`;
    }
    default:
      return "";
  }
}

export function promptText(blocks: acp.ContentBlock[], dir: AttachmentDir): string | Promise<string> {
  if (blocks.every((b) => b.type === "text")) return blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
  return attachmentsText(blocks, dir);
}

async function attachmentsText(blocks: acp.ContentBlock[], dir: AttachmentDir): Promise<string> {
  let out = "";
  for (const [index, block] of blocks.entries()) {
    const prev = blocks[index - 1];
    if (prev && (prev.type !== "text" || block.type !== "text")) out += "\n";
    out += await blockText(block, dir);
  }
  return out;
}
