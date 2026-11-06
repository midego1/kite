import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import { loadMessageBody } from "@/lib/email/bodies";
import { bodyBytesColumn, withStoredBodies } from "@/lib/messages/body-batches";
import { aiErrorHttpStatus, aiErrorMessage } from "../ai-error-utils";
import { TRANSLATION_ANSWER_TOKENS } from "../output-budget-utils";
import { checkedModelAnswer, SummaryRefusal } from "../summaries/model-answer";
import { loadAnchor, unavailableReason, type Anchor } from "../summaries/service";
import { isSummaryEligible, UNKNOWN_LANGUAGE } from "../summaries/summary-utils";
import { detectMessageLanguage } from "./detect-language-utils";
import {
	buildMessageTranslationPrompt,
	checkTranslationAnswer,
	SUBJECT_MAX_CHARS,
	translationProblemText,
	TRANSLATION_CHUNK_MAX_CHARS,
	TRANSLATION_MAX_CHUNKS,
} from "./prompt-utils";
import { messageSlots, planChunks, rebuildMessage, slotsDigest } from "./segment-utils";
import { readMessageTranslation, saveMessageTranslation } from "./store";
import type {
	CheckedTranslation,
	MessageTranslation,
	StoredTranslation,
	TranslationSource,
	TranslationState,
} from "./translation-types";

const TRANSLATION_CALL_TIMEOUT_MS = 90_000;
/** Requests running at once for a long message; each one is reserved on its own. */
const TRANSLATION_CONCURRENCY = 3;

type Parsed = TranslationSource & { subject: string; digest: string };

async function loadParsedMessage(env: CloudflareEnv, messageId: string): Promise<Parsed> {
	const db = getDb(env);
	const [row] = await db
		.select({ id: messages.id, subject: messages.subject, bodyBytes: bodyBytesColumn })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	const [stored] = row ? await withStoredBodies(db, [row]) : [];
	if (!stored) throw new SummaryRefusal(404, "Message not found", "not_found");
	const body = await loadMessageBody(env, stored);
	const parsed = messageSlots(body);
	return { ...parsed, subject: row.subject ?? "", digest: await slotsDigest(parsed.slots) };
}

const hasLetters = (text: string) => /\p{L}/u.test(text);
const known = (language: string) => (language === UNKNOWN_LANGUAGE ? null : language);
const detected = (parsed: Parsed) =>
	detectMessageLanguage(parsed.slots.map((slot) => slot.text).join("\n")) ?? UNKNOWN_LANGUAGE;

function present(parsed: Parsed, target: string, content: StoredTranslation, model: string | null): MessageTranslation {
	const body = rebuildMessage(parsed, content.segments);
	const missing = parsed.slots.map((slot, index) => (content.segments[index] ?? null) === null);
	const quotedMissing = parsed.slots.filter((slot, index) => slot.quoted && missing[index]).length;
	const quoted = parsed.slots.filter((slot) => slot.quoted).length;
	return {
		target,
		sourceLanguage: content.from,
		subject: content.subject,
		html: parsed.format === "html" ? body : null,
		text: parsed.format === "text" ? body : null,
		cut:
			parsed.slots.some((slot, index) => !slot.quoted && missing[index]) ||
			(quotedMissing > 0 && quotedMissing < quoted),
		quotedPending: quoted > 0 && quotedMissing === quoted,
		model,
	};
}

/**
 * The reader's translation of a message into `target`, when one is stored; no model call. A stored translation is
 * shown only when it lines up with the pieces of the body, and never with AI off for the mailbox.
 */
export async function getTranslationState(
	env: CloudflareEnv,
	user: SessionUser,
	messageId: string,
	target: string,
): Promise<TranslationState> {
	const anchor = await loadAnchor(getDb(env), user, messageId);
	const reason = await unavailableReason(env, isSummaryEligible(anchor), anchor.mailboxId);
	if (reason === "assistant_off" || reason === "mailbox_ai_off" || reason === "not_eligible")
		return { translation: null, reason };
	const stored = await readMessageTranslation(getDb(env), anchor.id, target);
	if (stored.pending) return { translation: null, migrationPending: true };
	const state: TranslationState = { translation: null, ...(reason ? { reason } : {}) };
	if (!stored.row) return state;
	const parsed = await loadParsedMessage(env, anchor.id);
	if (stored.row.digest !== parsed.digest) return state;
	return { ...state, translation: present(parsed, target, stored.row.content, stored.row.model) };
}

type TranslateInput = {
	env: CloudflareEnv;
	user: SessionUser;
	anchor: Anchor;
	parsed: Parsed;
	target: string;
	indexes: number[];
	/** Asks for the subject in the first request. */
	subject: string | null;
};

/** One request of a message's translation, with its answer checked against the pieces it carried. */
function translateChunk(input: TranslateInput, chunk: number[], subject: string | null) {
	const { parsed } = input;
	const sources = chunk.map((index) => parsed.slots[index].text);
	return checkedModelAnswer<CheckedTranslation>({
		env: input.env,
		userId: input.user.id,
		mailboxId: input.anchor.mailboxId,
		source: "message_translation",
		prompt: buildMessageTranslationPrompt({ subject, segments: sources, target: input.target }),
		answerTokens: TRANSLATION_ANSWER_TOKENS,
		timeoutMs: TRANSLATION_CALL_TIMEOUT_MS,
		check: (text) =>
			checkTranslationAnswer(text, {
				sources,
				references: [parsed.subject, ...parsed.slots.map((slot) => slot.text)],
				subject: subject !== null,
			}),
		problemText: translationProblemText,
	});
}

/**
 * Translates the slots in `indexes`, in as many requests as the limits allow, a few at a time. Any failed request
 * fails the whole translation: half a message is not worth keeping, and the same request can be tried again.
 */
async function translateSlots(input: TranslateInput) {
	const { chunks } = planChunks(input.parsed.slots, input.indexes, {
		maxChars: TRANSLATION_CHUNK_MAX_CHARS,
		maxChunks: TRANSLATION_MAX_CHUNKS,
		reserved: input.subject?.length ?? 0,
	});
	// A subject without a body still takes one request.
	const parts = chunks.length ? chunks : [[]];
	const answers: Awaited<ReturnType<typeof translateChunk>>[] = [];
	for (let at = 0; at < parts.length; at += TRANSLATION_CONCURRENCY) {
		const batch = parts.slice(at, at + TRANSLATION_CONCURRENCY);
		answers.push(
			...(await Promise.all(
				batch.map((chunk, offset) => translateChunk(input, chunk, at + offset === 0 ? input.subject : null)),
			)),
		);
	}
	const translated = new Map<number, string>();
	parts.forEach((chunk, part) => {
		chunk.forEach((index, position) => translated.set(index, answers[part].value.segments[position]));
	});
	return { translated, first: answers[0].value, modelId: answers[0].modelId };
}

/**
 * Translates a message into `target`, keeping the result, or returns what is kept with no model call. The new part
 * comes first; `quoted` adds the quoted history to what is stored. Anyone who can read the mailbox may do this,
 * read-only users of a shared mailbox too: it shows nothing they cannot read and is charged to the mailbox.
 */
export async function createTranslation(
	env: CloudflareEnv,
	user: SessionUser,
	messageId: string,
	request: { target: string; quoted: boolean },
): Promise<TranslationState> {
	const { target } = request;
	const db = getDb(env);
	const anchor = await loadAnchor(db, user, messageId);
	const reason = await unavailableReason(env, isSummaryEligible(anchor), anchor.mailboxId);
	if (reason === "mailbox_ai_off" || reason === "assistant_off")
		throw new SummaryRefusal(aiErrorHttpStatus(reason), aiErrorMessage(reason), reason);
	if (!isSummaryEligible(anchor)) throw new SummaryRefusal(409, "This message cannot be translated.", "not_eligible");
	const stored = await readMessageTranslation(db, anchor.id, target);
	if (stored.pending) throw new SummaryRefusal(409, "Apply the pending database update first", "MIGRATION_PENDING");
	const parsed = await loadParsedMessage(env, anchor.id);
	const subject = hasLetters(parsed.subject) ? Array.from(parsed.subject).slice(0, SUBJECT_MAX_CHARS).join("") : null;
	if (!parsed.slots.length && !subject)
		throw new SummaryRefusal(409, "This message has no text to translate.", "nothing_to_translate");
	const valid = stored.row?.digest === parsed.digest ? stored.row : null;
	const wanted = parsed.slots.flatMap((slot, index) => {
		if (!valid) return !slot.quoted || request.quoted ? [index] : [];
		return request.quoted && slot.quoted && (valid.content.segments[index] ?? null) === null ? [index] : [];
	});
	if (valid && !wanted.length) return { translation: present(parsed, target, valid.content, valid.model) };
	const { translated, first, modelId } = await translateSlots({
		env,
		user,
		anchor,
		parsed,
		target,
		indexes: wanted,
		subject: valid ? null : subject,
	});
	const content: StoredTranslation = {
		from: valid?.content.from ?? (known(first.language) || detected(parsed)),
		subject: valid ? valid.content.subject : first.subject,
		segments: parsed.slots.map((_, index) => translated.get(index) ?? valid?.content.segments[index] ?? null),
	};
	const saved = await saveMessageTranslation(env.DB, {
		mailboxId: anchor.mailboxId,
		threadKey: anchor.threadKey,
		messageId: anchor.id,
		language: target,
		content,
		digest: parsed.digest,
		modelId,
		userId: user.id,
	});
	if (!saved) throw new SummaryRefusal(409, "This message cannot be translated.", "not_eligible");
	return { translation: present(parsed, target, content, modelId) };
}
