import type { InstructionSet } from "@/lib/agent/instruction-types";

export type InstructionFieldKey = keyof InstructionSet;

export type InstructionField = { key: InstructionFieldKey; label: string; hint?: string };

/** The four fields, in the order they reach the prompt; the mailbox and personal sections both use them. */
export const INSTRUCTION_FIELDS: readonly InstructionField[] = [
	{ key: "general", label: "General instructions (all tasks)" },
	{ key: "chat", label: "Chat" },
	{ key: "draft", label: "Drafting and composer", hint: "Also used when Kite writes reply drafts on its own." },
	{ key: "summary", label: "Summaries", hint: "Saved for thread summaries, which are not available yet." },
];

/** "120 / 2000", the counter under each field. */
export function characterCount(value: string, max: number): string {
	return `${Array.from(value).length} / ${max}`;
}

export function overLimit(values: InstructionSet, limits: Record<InstructionFieldKey, number>): boolean {
	return INSTRUCTION_FIELDS.some((field) => Array.from(values[field.key]).length > limits[field.key]);
}
