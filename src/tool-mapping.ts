import type * as acp from "@agentclientprotocol/sdk";

export interface ToolInfo {
  kind: acp.ToolKind;
  title: string;
  locations?: acp.ToolCallLocation[];
}

type Input = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const at = (path: string | undefined): acp.ToolCallLocation[] | undefined => (path ? [{ path }] : undefined);

export function toolInfo(tool: string, input: Input): ToolInfo {
  const path = str(input.file_path) ?? str(input.notebook_path);
  switch (tool) {
    case "Task":
    case "Agent":
      return { kind: "think", title: str(input.description) ?? "Task" };
    case "Bash":
      return { kind: "execute", title: str(input.command)?.replaceAll("`", "\\`") ?? "Terminal" };
    case "Read": {
      const offset = typeof input.offset === "number" ? input.offset : undefined;
      const limit = typeof input.limit === "number" ? input.limit : undefined;
      const range = offset !== undefined || limit !== undefined ? ` (${offset ?? 1}${limit ? ` - ${(offset ?? 1) + limit - 1}` : ""})` : "";
      return { kind: "read", title: `Read ${path ?? "File"}${range}`, locations: path ? [{ path, line: offset ?? 0 }] : undefined };
    }
    case "Edit":
      return { kind: "edit", title: path ? `Edit ${path}` : "Edit", locations: at(path) };
    case "Write":
      return { kind: "edit", title: path ? `Write ${path}` : "Write", locations: at(path) };
    case "NotebookEdit":
      return { kind: "edit", title: path ? `Edit notebook ${path}` : "Edit notebook", locations: at(path) };
    case "Glob": {
      const dir = str(input.path);
      const pattern = str(input.pattern);
      return { kind: "search", title: `Find ${dir ? `\`${dir}\` ` : ""}${pattern ? `\`${pattern}\`` : ""}`.trim(), locations: at(dir) };
    }
    case "Grep": {
      const flags = [input["-i"] ? "-i" : "", input["-n"] ? "-n" : "", str(input.glob) ? `--include="${input.glob}"` : ""].filter(Boolean);
      const pattern = str(input.pattern);
      return { kind: "search", title: ["grep", ...flags, pattern ? `"${pattern}"` : "", str(input.path) ?? ""].filter(Boolean).join(" ") };
    }
    case "WebFetch":
      return { kind: "fetch", title: str(input.url) ? `Fetch ${input.url}` : "Fetch" };
    case "WebSearch":
      return { kind: "fetch", title: str(input.query) ?? "Web search" };
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? (input.todos as { content?: string }[]) : [];
      return { kind: "think", title: `Update TODOs: ${todos.map((t) => t.content).join(", ")}` };
    }
    case "ExitPlanMode":
      return { kind: "switch_mode", title: "Ready to code?" };
    default:
      return { kind: "other", title: tool };
  }
}

export function planEntries(tool: string, input: Input): acp.PlanEntry[] | undefined {
  if (tool !== "TodoWrite" || !Array.isArray(input.todos)) return undefined;
  return (input.todos as { content: string; status: acp.PlanEntryStatus }[]).map((t) => ({
    content: t.content,
    status: t.status,
    priority: "medium",
  }));
}
