#!/usr/bin/env node
// Manual end-to-end suite: drives the built Adapter (dist/) against a real `claude` in tmux.
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const echoMcp = fileURLToPath(new URL("./echo-mcp.mjs", import.meta.url));
const TURN_TIMEOUT_MS = 180_000;

class AdapterClient {
  nextId = 1;
  pending = new Map();
  updates = [];
  permissions = [];

  constructor() {
    this.child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "inherit"], env: process.env });
    createInterface({ input: this.child.stdout }).on("line", (line) => this.#onLine(line));
  }

  #send(msg) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  }

  #onLine(line) {
    const msg = JSON.parse(line);
    if (msg.method === "session/update") this.updates.push(msg.params.update);
    else if (msg.method === "session/request_permission") {
      this.permissions.push(msg.params);
      const allow = msg.params.options.find((o) => o.kind.startsWith("allow")) ?? msg.params.options[0];
      this.#send({ id: msg.id, result: { outcome: { outcome: "selected", optionId: allow.optionId } } });
    } else if (msg.method && msg.id !== undefined) {
      this.#send({ id: msg.id, error: { code: -32601, message: "unsupported by e2e client" } });
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message}${msg.error.data ? ` ${JSON.stringify(msg.error.data)}` : ""}`));
      else p.resolve(msg.result);
    }
  }

  request(method, params, timeoutMs = 60_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
      this.pending.set(id, {
        resolve: (r) => (clearTimeout(timer), resolve(r)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.#send({ id, method, params });
    });
  }

  agentText() {
    return this.updates
      .filter((u) => u.sessionUpdate === "agent_message_chunk" && u.content.type === "text")
      .map((u) => u.content.text)
      .join("");
  }

  stop() {
    this.child.kill("SIGTERM");
    return new Promise((resolve) => this.child.once("exit", resolve));
  }
}

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name}: ${err.message}`);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
const say = (text) => [{ type: "text", text }];

const cwd = await mkdtemp(join(tmpdir(), "cc-acp-e2e-"));
await writeFile(join(cwd, "hello.txt"), "e2e-file-contents\n");
let client = new AdapterClient();
let sessionId;
let initial;

await step("initialize", async () => {
  const init = await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  assert(init.agentCapabilities?.loadSession === true, "loadSession capability not advertised");
});

await step("session/new with a Client MCP server", async () => {
  initial = await client.request(
    "session/new",
    { cwd, mcpServers: [{ name: "echo", command: process.execPath, args: [echoMcp], env: [] }] },
    120_000,
  );
  sessionId = initial.sessionId;
  assert(initial.modes?.availableModes?.length > 0, "no modes offered");
  assert(initial.configOptions?.some((o) => o.category === "model" && o.options.length > 0), "no models offered");
});

await step("prompt: streamed text", async () => {
  const r = await client.request("session/prompt", { sessionId, prompt: say("Reply with exactly the word PONG and nothing else.") }, TURN_TIMEOUT_MS);
  assert(r.stopReason === "end_turn", `stopReason ${r.stopReason}`);
  assert(client.agentText().includes("PONG"), `no PONG in "${client.agentText()}"`);
});

await step("prompt: tool call and permission", async () => {
  client.updates.length = 0;
  client.permissions.length = 0;
  const r = await client.request(
    "session/prompt",
    { sessionId, prompt: say("Use the Bash tool to run `echo e2e-bash-ok`, then tell me what it printed.") },
    TURN_TIMEOUT_MS,
  );
  assert(r.stopReason === "end_turn", `stopReason ${r.stopReason}`);
  assert(client.updates.some((u) => u.sessionUpdate === "tool_call"), "no tool_call update");
  assert(client.agentText().includes("e2e-bash-ok"), "tool output not reported");
  console.log(`     permission requests seen: ${client.permissions.length}`);
});

await step("set_mode", async () => {
  const modes = initial.modes.availableModes.map((m) => m.id);
  const target = modes.find((m) => m !== initial.modes.currentModeId);
  await client.request("session/set_mode", { sessionId, modeId: target });
  assert(client.updates.some((u) => u.sessionUpdate === "current_mode_update" && u.currentModeId === target), `no current_mode_update for ${target}`);
});

await step("MCP tool call via proxy", async () => {
  client.updates.length = 0;
  const r = await client.request(
    "session/prompt",
    { sessionId, prompt: say("Call the echo MCP server's tool with the text e2e-mcp-ok and report what it returned verbatim.") },
    TURN_TIMEOUT_MS,
  );
  assert(r.stopReason === "end_turn", `stopReason ${r.stopReason}`);
  assert(client.agentText().includes("echo:e2e-mcp-ok"), "MCP result not reported");
});

await step("restart and session/load", async () => {
  await client.stop();
  client = new AdapterClient();
  await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  await client.request("session/load", { sessionId, cwd, mcpServers: [] }, 120_000);
  assert(client.updates.some((u) => u.sessionUpdate === "user_message_chunk"), "history not replayed");
  const r = await client.request("session/prompt", { sessionId, prompt: say("What exact word did I ask you to reply with in my first message? One word.") }, TURN_TIMEOUT_MS);
  assert(r.stopReason === "end_turn", `stopReason ${r.stopReason}`);
  assert(client.agentText().includes("PONG"), "context lost across load");
});

await client.stop();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
