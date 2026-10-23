import { SUGGESTION_KIND_ORDER } from "@/lib/agent/auto-read/suggestion-badge-utils";
import type { SuggestionKind } from "@/lib/agent/auto-read/suggestion-types";
import { CLIENT_MODULES } from "@/lib/modules/client-data";
import type { CardSections, CardSuggestion, WhyDetails } from "./suggestion-card-types";

const MODULE_KIND_META = CLIENT_MODULES.flatMap((entry) => Object.entries(entry.suggestionKindMeta ?? {}));

/** Kinds that get their own block in the reader card, in display order: phishing, reply and every module kind, by rank. */
const BLOCK_KINDS: readonly SuggestionKind[] = SUGGESTION_KIND_ORDER.filter(
	(kind) => kind === "phishing" || kind === "reply" || MODULE_KIND_META.some(([moduleKind]) => moduleKind === kind),
);

const REASON_TEXT: Record<string, string> = {
	...Object.assign({}, ...MODULE_KIND_META.map(([, meta]) => meta.reason)),
	needs_reply: "The message asks you something that needs an answer.",
	long_thread: "The message or conversation is long, so Kite summarised it.",
	phishing_signals: "The message shows signs of phishing.",
};

/** Deterministic signals first, then the reasons a model may add; each in plain words. */
const PHISHING_REASON_TEXT: Record<string, string> = {
	suspicious_verdict: "The spam filter marked this message as suspicious.",
	displayed_link_mismatch: "A link shows one web address but opens a different one.",
	ip_address_url: "A link points to a bare IP address instead of a website name.",
	punycode_url: "A link uses look-alike characters in its web address.",
	url_shortener: "A link goes through a URL shortener, which hides where it really leads.",
	spf_failed: "The sending server is not allowed to send for this domain (SPF failed).",
	dkim_failed: "The message's signature does not match its domain (DKIM failed).",
	dmarc_failed: "The sender's domain did not vouch for this message (DMARC failed).",
	display_name_spoof: "The sender uses the name of one of your contacts, but from a different address.",
	html_attachment: "An attachment is a web page (HTML or SVG), which can show a fake login page when opened.",
	attachment_login_form: "An attached web page asks for a password or sends what you type to a website.",
	attachment_active_content: "An attached web page runs hidden code or forwards you to a website.",
	risky_attachment: "An attachment is a program or disk image that could harm your computer.",
	urlhaus_url: "A link is on URLhaus's list of sites that spread malware.",
	urlhaus_payload: "An attachment matches malware known to URLhaus.",
	safelist_pressure: "It asks you to mark it as safe or to whitelist the sender, to get past the spam filter.",
	credential_request: "It asks for a password or other login details.",
	payment_change: "It asks you to pay or to change payment details.",
	urgency_pressure: "It pressures you to act quickly.",
	spoofed_identity: "The sender seems to pretend to be someone else.",
	unexpected_attachment: "It has an attachment you might not expect.",
	model_flagged: "Kite found the message suspicious.",
};
const OTHER_PHISHING_REASON = "Kite found another warning sign.";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The open suggestions of the whole conversation, so one made for an earlier message still shows
 * when a later one is opened. Without a thread the message's own suggestions are listed.
 */
export function suggestionCardUrl(messageId: string, threadId: string | null): string {
	const params = new URLSearchParams({ status: "open" });
	if (threadId) params.set("threadId", threadId);
	else params.set("messageId", messageId);
	return `/api/agent/suggestions?${params}`;
}

/** The answered invitations of the conversation, which keep offering "Send decline instead" or "Accept instead". */
export function answeredInviteUrl(messageId: string, threadId: string | null): string {
	return suggestionCardUrl(messageId, threadId).replace("status=open", "status=accepted");
}

/**
 * Picks what the card shows from suggestions listed newest first: the newest summary and the newest
 * open suggestion of each block kind, all from the message's own mailbox (thread ids are per mailbox).
 */
export function cardSections(
	suggestions: readonly CardSuggestion[],
	mailboxId: string | null,
	answeredInvites: readonly CardSuggestion[] = [],
): CardSections {
	const open = suggestions.filter((item) => item.status === "open" && item.mailboxId === mailboxId);
	const blocks: CardSuggestion[] = [];
	for (const kind of BLOCK_KINDS) {
		const newest = open.find((item) => item.kind === kind);
		if (newest) blocks.push(newest);
	}
	const answered = answeredInvites.find(
		(item) => item.status === "accepted" && item.kind === "calendar_invite" && item.mailboxId === mailboxId,
	);
	return { summary: open.find((item) => item.kind === "summary") ?? null, blocks, answered: answered ?? null };
}

export function hasCardContent(sections: CardSections): boolean {
	return sections.summary !== null || sections.blocks.length > 0 || sections.answered !== null;
}

export function summaryText(suggestion: CardSuggestion): string {
	const text = suggestion.payload.text;
	return typeof text === "string" ? text : "";
}

/** A phishing warning's reasons in plain words, in stored order and without repeats. */
export function phishingReasonTexts(suggestion: CardSuggestion): string[] {
	const reasons = Array.isArray(suggestion.payload.reasons) ? suggestion.payload.reasons : [];
	const texts = reasons.map((reason) =>
		typeof reason === "string" && Object.hasOwn(PHISHING_REASON_TEXT, reason)
			? PHISHING_REASON_TEXT[reason]
			: OTHER_PHISHING_REASON,
	);
	return [...new Set(texts)];
}

/** "Pause Kite for this mailbox" lasts a day from the click. */
export function pauseEnd(now: Date): string {
	return new Date(now.getTime() + DAY_MS).toISOString();
}

/** What Undo of a card Pause restores: an earlier pause that has not ended yet, otherwise no pause. */
export function pauseUndoValue(previous: string | null | undefined, now: Date): string | null {
	if (!previous) return null;
	const end = Date.parse(previous);
	return Number.isFinite(end) && end > now.getTime() ? previous : null;
}

/** The toast after "Not phishing", naming the sender Kite now trusts when the server returned one. */
export function notPhishingToast(sender: string | null | undefined): string {
	return `Marked as not phishing. Kite won't warn about ${sender || "this sender"} again unless the message itself shows a sign of phishing.`;
}

/**
 * The open phishing warnings of the open message that were not there before, so a live warning is
 * announced once. `known` is updated in place; null on the first list, which only records what exists.
 */
export function newPhishingWarnings(
	suggestions: readonly CardSuggestion[],
	messageId: string,
	known: Set<string> | null,
): { known: Set<string>; fresh: CardSuggestion[] } {
	const warnings = suggestions.filter(
		(item) => item.kind === "phishing" && item.status === "open" && item.messageId === messageId,
	);
	if (!known) return { known: new Set(warnings.map((item) => item.id)), fresh: [] };
	const fresh = warnings.filter((item) => !known.has(item.id));
	for (const item of fresh) known.add(item.id);
	return { known, fresh };
}

/** The policy rule behind a suggestion in plain words, and the model that read the message. */
export function whyDetails(suggestion: CardSuggestion): WhyDetails {
	const reason = suggestion.payload.reason;
	return {
		reason:
			(typeof reason === "string" && Object.hasOwn(REASON_TEXT, reason) && REASON_TEXT[reason]) ||
			"Kite's rules for this mailbox suggested this.",
		model: suggestion.model ? `Read by ${suggestion.model}.` : "Found by Kite's rules, without a model.",
	};
}

/** The reply block's status line. Someone other than the reviewer learns a draft exists, not its text. */
export function replyStatusText(suggestion: Pick<CardSuggestion, "draftId" | "canReviewDraft">): string {
	if (!suggestion.draftId) return "The drafted reply is gone.";
	return suggestion.canReviewDraft
		? "Kite drafted a reply. Review it before you send."
		: "Kite drafted a reply. It is in the reviewer's Drafts.";
}
