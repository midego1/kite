import { z } from "zod";

const strictEmail = z.string().email();

function isEmailAddress(value: string): boolean {
	return strictEmail.safeParse(value).success;
}

/**
 * One email address in a model-facing tool schema. Zod writes `z.string().email()` to JSON Schema as a
 * `pattern` with regex lookaheads, and OpenRouter rejects every request that carries one ("regex
 * lookaround is not supported"). The refinement keeps Zod's email check when the tool runs but is not
 * written to JSON Schema, which only gets `format: "email"`.
 */
export const toolEmailSchema = z
	.string()
	.refine(isEmailAddress, "Invalid email address")
	.meta({ format: "email", description: "A single email address" });
