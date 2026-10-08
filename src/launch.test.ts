import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { launchHostSession } from "./host-session.js";
import { checkClaudeVersion, checkTmux, compareVersions, MIN_CLAUDE_VERSION, trustDirectory } from "./launch.js";
import { socketPath } from "./paths.js";

test("compareVersions orders semver triples", () => {
  expect(compareVersions("2.1.293", "2.1.293")).toBe(0);
  expect(compareVersions("2.1.9", "2.1.293")).toBe(-1);
  expect(compareVersions("2.2.0", "2.1.293")).toBe(1);
});

test("trustDirectory marks only the requested cwd and keeps the rest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-acp-trust-"));
  try {
    const env = { CLAUDE_CONFIG_DIR: dir };
    await writeFile(join(dir, ".claude.json"), JSON.stringify({ theme: "dark", projects: { "/a": { x: 1 } } }));
    await trustDirectory("/b", env);
    const config = JSON.parse(await readFile(join(dir, ".claude.json"), "utf8"));
    expect(config.theme).toBe("dark");
    expect(config.projects["/a"]).toEqual({ x: 1 });
    expect(config.projects["/b"].hasTrustDialogAccepted).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("socketPath prefers XDG_RUNTIME_DIR then TMPDIR", () => {
  expect(socketPath("s", { XDG_RUNTIME_DIR: "/run/u", TMPDIR: "/t" })).toBe("/run/u/cc-acp/s.sock");
  expect(socketPath("s", { TMPDIR: "/t" })).toBe("/t/cc-acp/s.sock");
});

async function fakeBin(name: string, script: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cc-acp-bin-"));
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return { dir, path };
}

test("checkClaudeVersion names installed and required versions when too old", async () => {
  const bin = await fakeBin("claude", 'echo "1.0.0 (Claude Code)"');
  try {
    await expect(checkClaudeVersion(bin.path)).rejects.toThrow(
      new RegExp(`1\\.0\\.0.*${MIN_CLAUDE_VERSION.replaceAll(".", "\\.")}`),
    );
  } finally {
    await rm(bin.dir, { recursive: true, force: true });
  }
});

test("checkClaudeVersion accepts newer versions", async () => {
  const bin = await fakeBin("claude", 'echo "99.0.0 (Claude Code)"');
  try {
    await expect(checkClaudeVersion(bin.path)).resolves.toBeUndefined();
  } finally {
    await rm(bin.dir, { recursive: true, force: true });
  }
});

test("checkTmux reports tmux is required when missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-acp-empty-"));
  try {
    await expect(checkTmux({ PATH: dir })).rejects.toThrow(/tmux is required/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("launchHostSession times out with a likely-cause error and kills the tmux session", async () => {
  const bin = await fakeBin(
    "tmux",
    'case "$3" in -V) echo "tmux 3.4";; esac; case "$*" in *kill-session*) echo killed >> "$KILL_LOG";; esac',
  );
  const claude = await fakeBin("claude", 'echo "99.0.0"');
  const work = await mkdtemp(join(tmpdir(), "cc-acp-work-"));
  const killLog = join(work, "kill.log");
  try {
    vi.stubEnv("PATH", `${bin.dir}:${process.env.PATH}`);
    vi.stubEnv("KILL_LOG", killLog);
    const env = { ...process.env, CLAUDE_CODE_EXECUTABLE: claude.path, CLAUDE_CONFIG_DIR: work, TMPDIR: work };
    await expect(
      launchHostSession({ sessionId: "s1", cwd: work, env, onEvent: () => {}, startupTimeoutMs: 100 }),
    ).rejects.toThrow(/failed to start.*Likely cause/s);
    expect(await readFile(killLog, "utf8")).toContain("killed");
  } finally {
    vi.unstubAllEnvs();
    await Promise.all([bin.dir, claude.dir, work].map((d) => rm(d, { recursive: true, force: true })));
  }
});
