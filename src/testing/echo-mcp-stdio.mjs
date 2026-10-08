import { createInterface } from "node:readline";

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { via: "stdio", method: msg.method } })}\n`);
});
