import type { PhishingReport } from "@/lib/spam/phishing-report-types";

export function phishingConfirmCopy(count: number) {
	const them = count === 1 ? "it" : "them";
	return {
		title: count === 1 ? "Report as phishing?" : `Report ${count} messages as phishing?`,
		description: `Kite moves ${them} to Spam, learns from ${them} more strongly than from a spam report and blocks the ${count === 1 ? "sender" : "senders"}, so their mail goes to Trash. Saved contacts, people you have written to and your own domains are not blocked.`,
		confirmLabel: "Report phishing",
	};
}

const KEPT_BECAUSE: Record<NonNullable<PhishingReport["notBlocked"]>, string> = {
	no_sender: "it has no sender address",
	trusted_contact: "you saved or wrote to that address, and the sender may be forged",
	own_domain: "it uses one of your own domains, and the sender may be forged",
};

/** The toast after a report: what moved and which senders are now blocked. Null when nothing was reported. */
export function describePhishingReports(reports: readonly PhishingReport[]): string | null {
	if (reports.length === 0) return null;
	if (reports.length === 1) {
		const [report] = reports;
		if (report.blockedSender) return `Reported as phishing. Mail from ${report.blockedSender} now goes to Trash.`;
		return `Reported as phishing. The sender was not blocked because ${KEPT_BECAUSE[report.notBlocked ?? "no_sender"]}.`;
	}
	const blocked = new Set(reports.flatMap((report) => (report.blockedSender ? [report.blockedSender] : []))).size;
	const outcome =
		blocked === 0
			? "No senders were blocked."
			: blocked === 1
				? "1 sender is now blocked."
				: `${blocked} senders are now blocked.`;
	return `${reports.length} messages reported as phishing. ${outcome}`;
}
