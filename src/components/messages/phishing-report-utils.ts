import type { PhishingReport } from "@/lib/spam/phishing-report-types";
import { msg, t } from "@/lib/i18n/translator";

export function phishingConfirmCopy(count: number) {
	return {
		title: count === 1 ? t("Report as phishing?") : t("Report {count} messages as phishing?", { count }),
		description:
			count === 1
				? t(
						"Kite moves it to Spam, learns from it more strongly than from a spam report and blocks the sender, so their mail goes to Trash. Saved contacts, people you have written to and your own domains are not blocked.",
					)
				: t(
						"Kite moves them to Spam, learns from them more strongly than from a spam report and blocks the senders, so their mail goes to Trash. Saved contacts, people you have written to and your own domains are not blocked.",
					),
		confirmLabel: t("Report phishing"),
	};
}

const KEPT_BECAUSE: Record<NonNullable<PhishingReport["notBlocked"]>, string> = {
	no_sender: msg("Reported as phishing. The sender was not blocked because it has no sender address."),
	trusted_contact: msg(
		"Reported as phishing. The sender was not blocked because you saved or wrote to that address, and the sender may be forged.",
	),
	own_domain: msg(
		"Reported as phishing. The sender was not blocked because it uses one of your own domains, and the sender may be forged.",
	),
};

/** The toast after a report: what moved and which senders are now blocked. Null when nothing was reported. */
export function describePhishingReports(reports: readonly PhishingReport[]): string | null {
	if (reports.length === 0) return null;
	if (reports.length === 1) {
		const [report] = reports;
		if (report.blockedSender)
			return t("Reported as phishing. Mail from {blockedSender} now goes to Trash.", {
				blockedSender: report.blockedSender,
			});
		return t(KEPT_BECAUSE[report.notBlocked ?? "no_sender"]);
	}
	const blocked = new Set(reports.flatMap((report) => (report.blockedSender ? [report.blockedSender] : []))).size;
	const outcome =
		blocked === 0
			? t("No senders were blocked.")
			: blocked === 1
				? t("1 sender is now blocked.")
				: t("{blocked} senders are now blocked.", { blocked });
	return t("{count} messages reported as phishing. {outcome}", { count: reports.length, outcome });
}
