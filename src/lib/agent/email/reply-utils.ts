import { escapeHtml } from "@/lib/auth/password-reset-utils";

/** One line in a reply besides the conversation link: a send review or a pending action, each from Kite's own data. */
export type AssistantReplyLink = { label: string; url: string };

/** The dashboard path the reply's deep link opens: the assistant panel, on this conversation (spec §8.4). */
export function assistantConversationPath(conversationId: string): string {
	return `/inbox?assistant=${encodeURIComponent(conversationId)}`;
}

/** `appUrl` joined with `path`, or null when no public origin is configured (same convention as the alert emails). */
export function absoluteAppUrl(appUrl: string | null | undefined, path: string): string | null {
	const base = appUrl?.trim().replace(/\/+$/, "");
	return base ? `${base}${path}` : null;
}

/**
 * The assistant's reply body (spec §9): link only, built entirely from Kite's own data (the conversation id, and
 * each link's label and URL, which the caller derives from a draft's recipient or an action's kind) — never from
 * the model's text or the conversation's content, so a prompt injection in the request cannot put words into the
 * reply. `note` replaces the normal "has answered" line for a refusal or a failure (spec §4 step 5, §9's last
 * bullet); it must also be a fixed, plain-words string chosen by the caller, not model output.
 */
export function assistantReplyBody(input: {
	appUrl: string | null | undefined;
	conversationId: string | null;
	note?: string;
	links?: readonly AssistantReplyLink[];
}): { text: string; html: string } {
	const intro = input.note ?? "Kite has answered your request.";
	const conversationUrl = input.conversationId
		? absoluteAppUrl(input.appUrl, assistantConversationPath(input.conversationId))
		: null;
	const links = input.links ?? [];
	const textLines = [intro];
	const htmlParts = [`<p>${escapeHtml(intro)}</p>`];
	if (conversationUrl) {
		textLines.push("", conversationUrl);
		htmlParts.push(`<p><a href="${escapeHtml(conversationUrl)}">${escapeHtml(conversationUrl)}</a></p>`);
	} else if (!input.note) {
		// No public origin is configured (self-hosted without APP_URL): still useful without a dead link.
		textLines.push("", "Open Kite and look for this request in the assistant panel.");
	}
	for (const link of links) {
		textLines.push("", `${link.label}: ${link.url}`);
		htmlParts.push(`<p>${escapeHtml(link.label)}: <a href="${escapeHtml(link.url)}">${escapeHtml(link.url)}</a></p>`);
	}
	return { text: textLines.join("\n"), html: htmlParts.join("") };
}
