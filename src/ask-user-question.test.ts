import { expect, test } from "vitest";
import { formAnswers, questionForm } from "./ask-user-question.js";

const questions = [
  { question: "Which db?", header: "DB", options: [{ label: "pg", description: "Postgres" }, { label: "sqlite" }] },
  { question: "Which features?", options: [{ label: "a" }, { label: "b" }], multiSelect: true },
];

test("builds a form with the question options", () => {
  const form = questionForm(questions);
  expect(form.required).toEqual(["q0", "q1"]);
  expect(form.properties?.q0).toMatchObject({
    type: "string",
    title: "DB",
    description: "Which db?",
    oneOf: [{ const: "pg", title: "pg", description: "Postgres" }, { const: "sqlite", title: "sqlite" }],
  });
  expect(form.properties?.q1).toMatchObject({ type: "array", items: { anyOf: [{ const: "a" }, { const: "b" }] } });
});

test("maps form content to answers keyed by question text", () => {
  expect(formAnswers(questions, { q0: "pg", q1: ["a", "b"] })).toEqual({ "Which db?": "pg", "Which features?": "a, b" });
  expect(formAnswers(questions, null)).toEqual({});
});
