/**
 * Runs bookkeeping that follows an accepted delivery. Its failure is logged
 * and swallowed: the mail is already out, so it must never be reported as
 * failed or retried because a webhook, audit row or status update broke.
 */
export async function runPostDeliveryStep(label: string, step: () => Promise<unknown>): Promise<boolean> {
	try {
		await step();
		return true;
	} catch (error) {
		console.error(`Post-delivery step failed: ${label}`, error);
		return false;
	}
}
