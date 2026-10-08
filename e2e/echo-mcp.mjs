import { createInterface } from "node:readline";

const tools = [
  {
    name: "echo",
    description: "Returns the given text prefixed with echo:",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
];

function result(msg) {
  switch (msg.method) {
    case "initialize":
      return { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1.0.0" } };
    case "tools/list":
      return { tools };
    case "tools/call":
      return { content: [{ type: "text", text: `echo:${msg.params.arguments?.text ?? ""}` }] };
    default:
      return {};
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: result(msg) })}\n`);
});
