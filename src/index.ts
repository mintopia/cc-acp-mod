#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { serveAgent } from "./server.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

if (process.argv.includes("--version")) {
  console.log(version);
  process.exit(0);
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
const server = serveAgent(stream, version);
void server.closed.then(() => server.close()).finally(() => process.exit(0));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void server.close().finally(() => process.exit(0)));
}
