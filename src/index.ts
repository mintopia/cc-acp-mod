#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { CcAcpAgent } from "./agent.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

if (process.argv.includes("--version")) {
  console.log(version);
  process.exit(0);
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
let agent: CcAcpAgent | undefined;
const { AGENT_METHODS, CLIENT_METHODS } = acp;
const conn = acp
  .agent({ name: "cc-acp" })
  .onConnect((c) => {
    agent = new CcAcpAgent({ sessionUpdate: (p) => c.client.notify(CLIENT_METHODS.session_update, p) }, version);
  })
  .onRequest(AGENT_METHODS.initialize, (ctx) => agent!.initialize(ctx.params))
  .onRequest(AGENT_METHODS.session_new, (ctx) => agent!.newSession(ctx.params))
  .onRequest(AGENT_METHODS.authenticate, async () => (await agent!.authenticate(), {}))
  .onRequest(AGENT_METHODS.session_prompt, (ctx) => agent!.prompt(ctx.params, ctx.signal))
  .onRequest("_session/steering", (params) => params as Parameters<CcAcpAgent["steer"]>[0], (ctx) => agent!.steer(ctx.params))
  .onNotification(AGENT_METHODS.session_cancel, (ctx) => agent!.cancel(ctx.params))
  .connect(stream);
void conn.closed.then(() => agent?.close()).finally(() => process.exit(0));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void (agent?.close() ?? Promise.resolve()).finally(() => process.exit(0)));
}
