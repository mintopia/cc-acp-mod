import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compareVersions, trustDirectory } from "./launch.js";
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
