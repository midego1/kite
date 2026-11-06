import { t } from "@/lib/i18n/translator";
/** The confirmation before messages are reported as spam: it trains the filter, so it always asks. */
export function spamConfirmCopy(count: number) {
	return {
		title: count === 1 ? t("Report as spam?") : t("Report {count} messages as spam?", { count }),
		description:
			count === 1
				? t("Kite moves it to Spam, filters future mail from this sender as spam and learns from this message.")
				: t("Kite moves them to Spam, filters future mail like them as spam and learns from them."),
		confirmLabel: t("Report spam"),
	};
}
