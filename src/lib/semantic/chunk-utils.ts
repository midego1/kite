import { splitEmailAddressList } from "@/lib/email/address";
import { getLatestEmailContent, htmlToReadableText } from "@/lib/email/reply-content-utils";

/** The statuses whose messages are ever embedded; drafts, spam, trash, the Screener and module statuses never. */
export const SEMANTIC_ELIGIBLE_STATUSES = ["received", "sent", "archived"] as const;

/**
 * Whether a message may be embedded: an eligible status and not judged spam. Mirrors `isSummaryEligible`
 * (`src/lib/agent/summaries/summary-utils.ts`); the mailbox's "No AI for this mailbox" and `semantic_index`
 * switches are checked separately (the triggers and the drain re-check respectively), since this predicate only
 * looks at the message row itself.
 */
export function isSemanticEligibleMessage(message: { status: string; spamVerdict?: string | null }): boolean {
	return (SEMANTIC_ELIGIBLE_STATUSES as readonly string[]).includes(message.status) && message.spamVerdict !== "spam";
}

export type EmbeddingSourceMessage = {
	subject: string | null;
	fromAddr: string;
	toAddr: string;
	createdAt: Date;
	textBody?: string | null;
	htmlBody?: string | null;
	attachmentNames?: readonly string[];
};

/** `Subject:`, `From:`, `To:` (first three), `Date:` (ISO date) and `Attachments:` (file names only). */
export function buildEmbeddingHeader(message: EmbeddingSourceMessage): string {
	const lines: string[] = [];
	if (message.subject) lines.push(`Subject: ${message.subject}`);
	lines.push(`From: ${message.fromAddr}`);
	const to = splitEmailAddressList(message.toAddr).slice(0, 3).join(", ");
	if (to) lines.push(`To: ${to}`);
	lines.push(`Date: ${message.createdAt.toISOString().slice(0, 10)}`);
	if (message.attachmentNames && message.attachmentNames.length > 0)
		lines.push(`Attachments: ${message.attachmentNames.join(", ")}`);
	return lines.join("\n");
}

/**
 * The readable body with quoted replies removed and whitespace collapsed. Quote detection reuses
 * `getLatestEmailContent` (lines starting with `>`, an "On … wrote:" line, an "Original Message" separator), since
 * by the time `htmlToReadableText` has run the HTML-level `wrapQuotedHtml` marker is already gone.
 */
export function embeddingBodyText(message: Pick<EmbeddingSourceMessage, "textBody" | "htmlBody">): string {
	const raw = message.textBody || htmlToReadableText(message.htmlBody);
	return getLatestEmailContent(raw)
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** About 1,500 characters (~400 tokens) per chunk. */
export const CHUNK_CHARS = 1_500;
/** Characters of overlap carried from the end of one chunk to the start of the next. */
export const CHUNK_OVERLAP = 200;
/** At most this many chunks per message; text after that is still found by keyword search. */
export const MAX_CHUNKS = 8;

type Segment = { text: string; glue: string };

/** Sentence boundaries within one paragraph that is itself over `CHUNK_CHARS`. */
function sentenceSegments(paragraph: string): Segment[] {
	return paragraph
		.split(/(?<=[.!?])\s+/)
		.filter(Boolean)
		.map((text) => ({ text, glue: " " }));
}

/** Paragraphs first, falling back to sentences within any paragraph longer than one chunk. */
function bodySegments(text: string): Segment[] {
	const paragraphs = text.split(/\n{2,}/).filter((part) => part.trim().length > 0);
	const segments: Segment[] = [];
	for (const paragraph of paragraphs) {
		if (paragraph.length <= CHUNK_CHARS) segments.push({ text: paragraph, glue: "\n\n" });
		else
			segments.push(
				...sentenceSegments(paragraph).map((segment, index) => (index === 0 ? { ...segment, glue: "\n\n" } : segment)),
			);
	}
	return segments;
}

/** Appends `text` to `current`, hard-splitting on plain characters only when a single segment alone overflows a chunk. */
function pushHardSplit(chunks: string[], text: string): string {
	let rest = text;
	while (rest.length > CHUNK_CHARS && chunks.length < MAX_CHUNKS) {
		chunks.push(rest.slice(0, CHUNK_CHARS));
		rest = rest.slice(CHUNK_CHARS - CHUNK_OVERLAP);
	}
	return rest;
}

/**
 * Splits `text` into at most `MAX_CHUNKS` chunks of about `CHUNK_CHARS` characters, breaking at paragraph then
 * sentence boundaries, with `CHUNK_OVERLAP` characters carried over from the end of one chunk to the next.
 */
export function chunkEmbeddingBody(text: string): string[] {
	const segments = bodySegments(text.slice(0, CHUNK_CHARS * MAX_CHUNKS));
	const chunks: string[] = [];
	let current = "";
	for (const segment of segments) {
		if (chunks.length >= MAX_CHUNKS) break;
		const candidate = current ? `${current}${segment.glue}${segment.text}` : segment.text;
		if (current && candidate.length > CHUNK_CHARS) {
			chunks.push(current);
			if (chunks.length >= MAX_CHUNKS) {
				current = "";
				break;
			}
			const tail = current.slice(-CHUNK_OVERLAP);
			current = pushHardSplit(chunks, segment.text);
			if (chunks.length < MAX_CHUNKS) current = tail ? `${tail}${segment.glue}${current}` : current;
		} else {
			current = pushHardSplit(chunks, candidate);
		}
	}
	if (current && chunks.length < MAX_CHUNKS) chunks.push(current);
	return chunks.slice(0, MAX_CHUNKS);
}

/**
 * The texts `getEmbeddingProvider(env).embedTexts()` is called with for one message: the header repeated at the top of
 * every chunk, at most `MAX_CHUNKS` of them. Never called for an ineligible message or one whose mailbox has AI off.
 */
export function buildEmbeddingText(message: EmbeddingSourceMessage): string[] {
	const header = buildEmbeddingHeader(message);
	const body = embeddingBodyText(message);
	const chunks = chunkEmbeddingBody(body);
	if (chunks.length === 0) return [header];
	return chunks.map((chunk) => `${header}\n\n${chunk}`);
}
