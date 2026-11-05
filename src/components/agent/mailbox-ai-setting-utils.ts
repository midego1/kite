/** The message of a failed "No AI for this mailbox" save, from the route's `{ error }` body. */
export async function mailboxAiSaveError(response: Response): Promise<string> {
	const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
	if (typeof body?.error === "string") return body.error;
	return response.status === 403
		? "Only people who manage this mailbox can change this."
		: "Could not save. Try again.";
}
