import { z } from "zod";

// An ISO 639-1 code, the language the reader asks for.
const target = z
	.string()
	.trim()
	.regex(/^[a-z]{2}$/);

export const translationQuerySchema = z.object({ target });

export const translationRequestSchema = z.object({ target, quoted: z.boolean().optional() });
