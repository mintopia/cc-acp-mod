import { expect, test } from "vitest";
import { buildModelList, initialModelId, parseModelConfig } from "./models.js";

test("built-in catalogue is used when nothing is configured", () => {
  const ids = buildModelList({}).map((m) => m.id);
  expect(ids).toEqual(["default", "opus", "sonnet", "haiku"]);
  expect(initialModelId({})).toBe("default");
});

test("CLAUDE_MODEL_CONFIG overrides and extends the catalogue (array and map forms)", () => {
  const array = JSON.stringify([{ id: "opus", name: "Big", description: "d" }, { id: "x-1" }]);
  const list = buildModelList({ CLAUDE_MODEL_CONFIG: array });
  expect(list.find((m) => m.id === "opus")).toEqual({ id: "opus", name: "Big", description: "d" });
  expect(list.find((m) => m.id === "x-1")).toEqual({ id: "x-1", name: "x-1" });
  expect(parseModelConfig(JSON.stringify({ a: { name: "A" }, b: {} }))).toEqual([
    { id: "a", name: "A" },
    { id: "b", name: "b" },
  ]);
});

test("malformed CLAUDE_MODEL_CONFIG is ignored", () => {
  expect(parseModelConfig("{nope")).toEqual([]);
  expect(buildModelList({ CLAUDE_MODEL_CONFIG: "[1,2]" })).toHaveLength(4);
});

test("ANTHROPIC_MODEL selects the initial model and is listed even when unknown", () => {
  const env = { ANTHROPIC_MODEL: "claude-custom-9" };
  expect(initialModelId(env)).toBe("claude-custom-9");
  expect(buildModelList(env).some((m) => m.id === "claude-custom-9")).toBe(true);
});

test("modelArgs omits --model for the default model", async () => {
  const { modelArgs } = await import("./host-session.js");
  expect(modelArgs({})).toEqual([]);
  expect(modelArgs({ ANTHROPIC_MODEL: "opus" })).toEqual(["--model", "opus"]);
});
