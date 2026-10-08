import type * as acp from "@agentclientprotocol/sdk";

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
}

const key = (index: number) => `q${index}`;

export function questionForm(questions: AskQuestion[]): acp.ElicitationSchema {
  const properties: Record<string, acp.ElicitationPropertySchema> = {};
  questions.forEach((q, i) => {
    const options = q.options.map((o) => ({ const: o.label, title: o.label, description: o.description }));
    const common = { title: q.header ?? q.question, description: q.question };
    properties[key(i)] = q.multiSelect
      ? { ...common, type: "array", minItems: 1, items: { anyOf: options } }
      : { ...common, type: "string", oneOf: options };
  });
  return { type: "object", properties, required: questions.map((_, i) => key(i)) };
}

export function formAnswers(
  questions: AskQuestion[],
  content: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const answers: Record<string, string> = {};
  questions.forEach((q, i) => {
    const value = content?.[key(i)];
    if (value === undefined) return;
    answers[q.question] = Array.isArray(value) ? value.join(", ") : String(value);
  });
  return answers;
}
