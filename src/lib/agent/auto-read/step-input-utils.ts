import type { MessageFacts } from "./facts-types";

/** The most of the readable body text a triage step receives. @public Test-only: used inside this file, exported for tests. */
export const STEP_TEXT_EXCERPT_CHARS = 8_192;
/** Header values are attacker-controlled; anything longer is cut, not dropped. */
const MAX_HEADER_CHARS = 4_096;

type StepSource = {
	id: string;
	fromAddr: string;
	subject: string | null;
	createdAt: Date;
};

type StepAttachment = { id: string; contentType: string; filename: string | null; size: number };

export type StepInputParts = {
	source: StepSource;
	mailboxId: string;
	facts: MessageFacts;
	/** The raw headers triage already read: lower-case names, first value of each. */
	headers: Record<string, string>;
	/** The readable body text triage computed (text part, or text from the HTML part). */
	bodyText: string;
	attachments: StepAttachment[];
	model: unknown;
};

/** At most 8,192 characters of the body, without splitting a surrogate pair; null when there is no text. @public Test-only: used inside this file, exported for tests. */
export function stepTextExcerpt(bodyText: string): string | null {
	if (!bodyText) return null;
	if (bodyText.length <= STEP_TEXT_EXCERPT_CHARS) return bodyText;
	const cut = bodyText.slice(0, STEP_TEXT_EXCERPT_CHARS);
	return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

function headerValue(headers: Record<string, string>, name: string): string | null {
	const value = Object.hasOwn(headers, name) ? headers[name] : undefined;
	if (typeof value !== "string" || !value.trim()) return null;
	return value.trim().slice(0, MAX_HEADER_CHARS);
}

/** The three list headers a step may read, from the header map triage loaded. @public Test-only: used inside this file, exported for tests. */
export function stepHeaders(headers: Record<string, string>) {
	return {
		listUnsubscribe: headerValue(headers, "list-unsubscribe"),
		listUnsubscribePost: headerValue(headers, "list-unsubscribe-post"),
		listId: headerValue(headers, "list-id"),
	};
}

/**
 * The JSON a triage step receives. A step whose schema predates the excerpt, extra facts and headers
 * gets them stripped by its own input schema, so its input is unchanged.
 */
export function buildStepInput(parts: StepInputParts) {
	const { source, facts } = parts;
	return {
		message: {
			id: source.id,
			mailboxId: parts.mailboxId,
			from: source.fromAddr,
			fromName: facts.senderName,
			subject: source.subject,
			receivedAt: source.createdAt.toISOString(),
			textExcerpt: stepTextExcerpt(parts.bodyText),
		},
		facts: {
			authPassed: facts.authPassed,
			bulk: facts.bulk,
			knownContact: facts.knownContact,
			phishing: facts.phishingSignals,
			automatic: facts.automatic,
			noReply: facts.noReply,
			list: facts.list,
			spam: facts.spamVerdict === "spam",
		},
		headers: stepHeaders(parts.headers),
		attachments: parts.attachments,
		model: parts.model ?? null,
	};
}
