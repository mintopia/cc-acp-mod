import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import * as Ajv2020Module from "ajv/dist/2020.js";
import { SessionChannel } from "../channel.js";
import type { HostLauncher } from "../agent.js";
import { serveAgent } from "../server.js";
import { ModeTracker } from "../host-session.js";
import { resolveModes } from "../modes.js";
import { FakeMod } from "./fake-mod.js";

const schema = createRequire(import.meta.url)("@agentclientprotocol/sdk/schema/schema.json") as object;
const Ajv2020 = (Ajv2020Module as unknown as { default: new (o: object) => import("ajv").default }).default;
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(schema, "acp");
const validate = ajv.getSchema("acp#/anyOf/0")!;

const RESULT_DEFS: Record<string, string> = {
  initialize: "InitializeResponse",
  authenticate: "AuthenticateResponse",
  "session/new": "NewSessionResponse",
  "session/load": "LoadSessionResponse",
  "session/fork": "ForkSessionResponse",
  "session/list": "ListSessionsResponse",
  "session/resume": "ResumeSessionResponse",
  "session/close": "CloseSessionResponse",
  "session/delete": "DeleteSessionResponse",
  "session/prompt": "PromptResponse",
  "session/set_config_option": "SetSessionConfigOptionResponse",
};
const PARAM_DEFS: Record<string, string> = { "session/update": "SessionNotification" };

function check(def: string, value: unknown): string | undefined {
  const fn = ajv.getSchema(`acp#/$defs/${def}`)!;
  return fn(value) ? undefined : `${def}: ${ajv.errorsText(fn.errors)}`;
}

export function schemaViolation(message: JsonRpcMessage, requestMethod?: string): string | undefined {
  if (!validate(message)) return ajv.errorsText(validate.errors);
  if (message.method) {
    const def = PARAM_DEFS[message.method];
    return def ? check(def, message.params) : `unexpected Adapter-emitted method ${message.method}`;
  }
  if (message.error) return undefined;
  const def = requestMethod && RESULT_DEFS[requestMethod];
  return def ? check(def, message.result) : `response to unknown request method ${requestMethod}`;
}

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface Harness {
  readonly emitted: JsonRpcMessage[];
  readonly mods: Map<string, FakeMod>;
  readonly resumed: Map<string, boolean>;
  readonly forkedFrom: Map<string, string>;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): Promise<void>;
  newSession(cwd?: string): Promise<{ sessionId: string; mod: FakeMod }>;
  updates(sessionId: string): acp.SessionNotification["update"][];
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "cc-acp-harness-"));
  const mods = new Map<string, FakeMod>();
  const channels: SessionChannel[] = [];
  const resumed = new Map<string, boolean>();
  const forkedFrom = new Map<string, string>();

  const launch: HostLauncher = async ({ sessionId, onEvent, resume, forkFrom }) => {
    if (forkFrom) forkedFrom.set(sessionId, forkFrom);
    resumed.set(sessionId, resume === true);
    const channel = new SessionChannel(join(dir, `${sessionId}.sock`));
    const modes = resolveModes([], {}, false);
    const mode = new ModeTracker(modes.initialMode);
    channel.onEvent = (event) => onEvent(event, mode);
    await channel.listen();
    channels.push(channel);
    const mod = new FakeMod(channel.path, sessionId);
    mods.set(sessionId, mod);
    await mod.connect();
    await channel.waitForHello(2000);
    return { sessionId, channel, modes, mode };
  };

  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  const server = serveAgent(acp.ndJsonStream(toClient.writable, toAgent.readable), "0", launch);

  const emitted: JsonRpcMessage[] = [];
  const pending = new Map<number | string, (m: JsonRpcMessage) => void>();
  const methods = new Map<number | string, string>();
  const writer = toAgent.writable.getWriter();
  const encoder = new TextEncoder();
  const send = (m: object) => writer.write(encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`));
  let nextId = 1;
  const violations: string[] = [];

  const reader = toClient.readable.getReader();
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      const chunk = r.value;
      buffer += decoder.decode(chunk, { stream: true });
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const message = JSON.parse(line) as JsonRpcMessage;
        emitted.push(message);
        const violation = schemaViolation(message, message.id === undefined ? undefined : methods.get(message.id));
        if (violation) violations.push(`${line}\n${violation}`);
        if (message.id !== undefined && !message.method) pending.get(message.id)?.(message);
      }
    }
  })();

  const h: Harness = {
    emitted,
    mods,
    resumed,
    forkedFrom,
    async request<T>(method: string, params?: unknown) {
      const id = nextId++;
      const reply = new Promise<JsonRpcMessage>((resolve) => pending.set(id, resolve));
      methods.set(id, method);
      await send({ id, method, params });
      const res = await reply;
      if (res.error) throw new Error(`${method}: ${res.error.message}`);
      return res.result as T;
    },
    notify: (method, params) => send({ method, params }),
    async newSession(cwd = "/") {
      const { sessionId } = await h.request<acp.NewSessionResponse>("session/new", { cwd, mcpServers: [] });
      return { sessionId, mod: mods.get(sessionId)! };
    },
    updates: (sessionId) =>
      emitted
        .filter((m) => m.method === "session/update" && (m.params as acp.SessionNotification).sessionId === sessionId)
        .map((m) => (m.params as acp.SessionNotification).update),
    async close() {
     
      for (const mod of mods.values()) mod.halt();
      await writer.close().catch(() => {});
      await server.close();
      await Promise.all([...mods.values()].map((m) => m.stop()));
      await Promise.all(channels.map((c) => c.close()));
      await reader.cancel().catch(() => {});
      await reading.catch(() => {});
      await rm(dir, { recursive: true, force: true });
      if (violations.length) throw new Error(`Adapter emitted schema-invalid ACP messages:\n${violations.join("\n---\n")}`);
    },
  };
  await h.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION });
  return h;
}
