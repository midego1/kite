import type { Message } from "@/hooks/types";
import { t } from "@/lib/i18n/translator";

export type MessageRowBadge = { label: string; tone: "neutral" | "warning" | "match" };

/**
 * The badges a list row shows: a suspicious spam verdict, a snooze outside the Snoozed folder (which is
 * about nothing else), and a search by meaning hit the keyword index would have missed. Kite has folders
 * rather than labels, and a row already sits in its folder.
 */
export function getMessageRowBadges(
	message: Pick<Message, "spamVerdict" | "snoozedUntil" | "match">,
	folder: string,
	now = Date.now(),
): MessageRowBadge[] {
	const badges: MessageRowBadge[] = [];
	if (message.spamVerdict === "suspicious" && folder !== "spam")
		badges.push({ label: t("Suspicious"), tone: "warning" });
	if (folder !== "snoozed" && message.snoozedUntil && Date.parse(message.snoozedUntil) > now)
		badges.push({ label: t("Snoozed"), tone: "neutral" });
	if (message.match === "meaning") badges.push({ label: t("Found by meaning, not exact words"), tone: "match" });
	return badges;
}
