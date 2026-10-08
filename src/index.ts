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
const conn = new acp.AgentSideConnection((c) => (agent = new CcAcpAgent(c, version)), stream);
void conn.closed.then(() => agent?.close()).finally(() => process.exit(0));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void (agent?.close() ?? Promise.resolve()).finally(() => process.exit(0)));
}
