/** The confirmation before messages are reported as spam: it trains the filter, so it always asks. */
export function spamConfirmCopy(count: number) {
	return {
		title: count === 1 ? "Report as spam?" : `Report ${count} messages as spam?`,
		description:
			count === 1
				? "Kite moves it to Spam, filters future mail from this sender as spam and learns from this message."
				: "Kite moves them to Spam, filters future mail like them as spam and learns from them.",
		confirmLabel: "Report spam",
	};
}
