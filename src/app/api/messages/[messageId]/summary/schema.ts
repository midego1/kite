import { z } from "zod";

const scope = z.enum(["thread", "message"]).default("thread");
// The browser's language as sent by the reader; only its primary subtag is used.
const language = z
	.string()
	.trim()
	.max(35)
	.regex(/^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*$/)
	.nullish();

export const summaryQuerySchema = z.object({ scope, language });

export const summaryRequestSchema = z.object({
	scope,
	language,
	translateTo: z
		.string()
		.trim()
		.regex(/^[a-z]{2}$/)
		.nullish(),
});
