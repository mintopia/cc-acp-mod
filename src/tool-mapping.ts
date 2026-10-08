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

export function diffContent(tool: string, input: Input): acp.ToolCallContent[] | undefined {
  const path = str(input.file_path);
  if (!path) return undefined;
  if (tool === "Edit" && typeof input.new_string === "string") {
    return [{ type: "diff", path, oldText: typeof input.old_string === "string" ? input.old_string : "", newText: input.new_string }];
  }
  if (tool === "Write" && typeof input.content === "string") return [{ type: "diff", path, oldText: null, newText: input.content }];
  return undefined;
}

export function bashOutput(result: unknown): { text: string; exitCode?: number } {
  if (typeof result === "string") return { text: result };
  const r = (result ?? {}) as Record<string, unknown>;
  const text = [r.stdout, r.stderr].filter((s): s is string => typeof s === "string" && s !== "").join("\n");
  const exitCode = [r.exitCode, r.exit_code].find((c): c is number => typeof c === "number");
  return { text, exitCode };
}

export function planEntries(tool: string, input: Input): acp.PlanEntry[] | undefined {
  if (tool !== "TodoWrite" || !Array.isArray(input.todos)) return undefined;
  return (input.todos as { content: string; status: acp.PlanEntryStatus }[]).map((t) => ({
    content: t.content,
    status: t.status,
    priority: "medium",
  }));
}

interface TrackedTask {
  subject: string;
  status: acp.PlanEntryStatus;
}

export class TaskPlan {
  private readonly tasks = new Map<string, TrackedTask>();

  apply(tool: string, input: Input, result: unknown): acp.PlanEntry[] | undefined {
    const r = (result ?? {}) as Record<string, any>;
    if (tool === "TaskCreate" && r.task?.id) {
      this.tasks.set(String(r.task.id), { subject: String(r.task.subject ?? input.subject ?? ""), status: "pending" });
    } else if (tool === "TaskUpdate" && r.success !== false && str(input.taskId)) {
      const id = input.taskId as string;
      if (input.status === "deleted") this.tasks.delete(id);
      else {
        const task = this.tasks.get(id);
        if (!task) return undefined;
        if (str(input.subject)) task.subject = input.subject as string;
        if (input.status === "pending" || input.status === "in_progress" || input.status === "completed") task.status = input.status;
      }
    } else if (tool === "TaskList" && Array.isArray(r.tasks)) {
      this.tasks.clear();
      for (const t of r.tasks) this.tasks.set(String(t.id), { subject: String(t.subject), status: t.status });
    } else {
      return undefined;
    }
    return [...this.tasks.values()].map((t) => ({ content: t.subject, status: t.status, priority: "medium" }));
  }
}
