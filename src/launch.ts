import { readFile, rename, writeFile } from "node:fs/promises";
import { claudeConfigFile } from "./paths.js";
import { run } from "./tmux.js";

export const MIN_CLAUDE_VERSION = "2.1.293";

export function compareVersions(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

export async function checkClaudeVersion(executable: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await run(executable, ["--version"], { env }));
  } catch (err) {
    throw new Error(`Cannot run ${executable} --version: ${(err as Error).message}`);
  }
  const installed = /\d+\.\d+\.\d+/.exec(stdout)?.[0];
  if (!installed) throw new Error(`Could not parse Claude Code version from "${stdout.trim()}"`);
  if (compareVersions(installed, MIN_CLAUDE_VERSION) < 0) {
    throw new Error(`Claude Code ${installed} is installed but cc-acp requires at least ${MIN_CLAUDE_VERSION}`);
  }
}

export async function checkTmux(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    await run("tmux", ["-V"], { env });
  } catch {
    throw new Error("tmux is required by cc-acp but was not found on PATH");
  }
}

export async function trustDirectory(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const file = claudeConfigFile(env);
  let config: { projects?: Record<string, Record<string, unknown>> } = {};
  try {
    config = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  config.projects ??= {};
  const project = (config.projects[cwd] ??= {});
  if (project.hasTrustDialogAccepted === true) return;
  project.hasTrustDialogAccepted = true;
  const tmp = `${file}.cc-acp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}
