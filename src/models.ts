export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
}

export const MODEL_CONFIG_ID = "model";

export const BUILT_IN_MODELS: ModelInfo[] = [
  { id: "default", name: "Default", description: "Claude Code's recommended model" },
  { id: "opus", name: "Opus", description: "Most capable model" },
  { id: "sonnet", name: "Sonnet", description: "Fast, capable model" },
  { id: "haiku", name: "Haiku", description: "Fastest model" },
];

/** CLAUDE_MODEL_CONFIG is JSON: an array of `{id, name?, description?}` or a map of `id -> {name?, description?}`. */
export function parseModelConfig(raw: string | undefined): ModelInfo[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const entries: [string, Record<string, unknown>][] = Array.isArray(parsed)
    ? parsed.filter(isRecord).map((m) => [String(m.id ?? ""), m])
    : isRecord(parsed)
      ? Object.entries(parsed).map(([id, m]) => [id, isRecord(m) ? m : {}])
      : [];
  return entries
    .filter(([id]) => id !== "")
    .map(([id, m]) => ({
      id,
      name: typeof m.name === "string" ? m.name : id,
      ...(typeof m.description === "string" ? { description: m.description } : {}),
    }));
}

export function buildModelList(env: NodeJS.ProcessEnv): ModelInfo[] {
  const byId = new Map(BUILT_IN_MODELS.map((m) => [m.id, m]));
  for (const m of parseModelConfig(env.CLAUDE_MODEL_CONFIG)) byId.set(m.id, m);
  const initial = env.ANTHROPIC_MODEL;
  if (initial && !byId.has(initial)) byId.set(initial, { id: initial, name: initial });
  return [...byId.values()];
}

export function initialModelId(env: NodeJS.ProcessEnv): string {
  return env.ANTHROPIC_MODEL || BUILT_IN_MODELS[0]!.id;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
