import { z } from "zod";
import { isKnownLanguage } from "@/lib/agent/summaries/summary-utils";

// An ISO 639-1 code, the language the reader asks for.
const target = z
	.string()
	.trim()
	.regex(/^[a-z]{2}$/)
	.refine(isKnownLanguage);

export const translationQuerySchema = z.object({ target });

export const translationRequestSchema = z.object({ target, quoted: z.boolean().optional() });
