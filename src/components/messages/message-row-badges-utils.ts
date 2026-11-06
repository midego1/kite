import type { Message } from "@/hooks/types";
import { t } from "@/lib/i18n/translator";

export type MessageRowBadge = { label: string; tone: "neutral" | "warning" };

/**
 * The badges a list row shows: a suspicious spam verdict, and a snooze outside the Snoozed folder (which is
 * about nothing else). Kite has folders rather than labels, and a row already sits in its folder.
 */
export function getMessageRowBadges(
	message: Pick<Message, "spamVerdict" | "snoozedUntil">,
	folder: string,
	now = Date.now(),
): MessageRowBadge[] {
	const badges: MessageRowBadge[] = [];
	if (message.spamVerdict === "suspicious" && folder !== "spam")
		badges.push({ label: t("Suspicious"), tone: "warning" });
	if (folder !== "snoozed" && message.snoozedUntil && Date.parse(message.snoozedUntil) > now)
		badges.push({ label: t("Snoozed"), tone: "neutral" });
	return badges;
}
