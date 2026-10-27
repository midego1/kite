import { z } from "zod";
import {
	COMPOSE_CUSTOM_MAX_CHARS,
	COMPOSE_INSTRUCTION_MAX_CHARS,
	COMPOSE_LANGUAGE_MAX_CHARS,
	COMPOSE_TEXT_MAX_CHARS,
} from "@/lib/agent/compose-prompt-utils";

const ACTIONS = ["shorter", "longer", "formal", "casual", "grammar", "translate", "custom"] as const;

/** A composer request; which fields are required depends on the mode and the action. */
export const composeRequestSchema = z
	.object({
		mailboxId: z.string().min(1).max(200),
		mode: z.enum(["write", "rewrite"]),
		action: z.enum(ACTIONS).optional(),
		instruction: z.string().trim().max(COMPOSE_INSTRUCTION_MAX_CHARS).optional(),
		language: z
			.string()
			.trim()
			.max(COMPOSE_LANGUAGE_MAX_CHARS)
			.regex(/^[\p{L}][\p{L} -]*$/u)
			.optional(),
		text: z.string().max(COMPOSE_TEXT_MAX_CHARS).optional(),
		subject: z.string().max(500).optional(),
		to: z.array(z.string().max(320)).max(20).optional(),
		inReplyTo: z.string().max(1_000).nullish(),
		threadId: z.string().max(200).nullish(),
	})
	.superRefine((value, context) => {
		const fail = (message: string) => context.addIssue({ code: "custom", message });
		if (value.mode === "write" && !value.instruction) fail("Say what the email should say");
		if (value.mode !== "rewrite") return;
		if (!value.action) fail("Choose a rewrite");
		if (!value.text?.trim()) fail("There is no text to rewrite");
		if (value.action === "translate" && !value.language) fail("Choose a language");
		if (value.action === "custom" && !value.instruction) fail("Say how to rewrite the text");
		if (value.action === "custom" && (value.instruction?.length ?? 0) > COMPOSE_CUSTOM_MAX_CHARS)
			fail(`The instruction can be at most ${COMPOSE_CUSTOM_MAX_CHARS} characters`);
	});
