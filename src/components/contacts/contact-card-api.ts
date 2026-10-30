import { authFetch } from "@/lib/auth/client";
import { getEmailAddress } from "@/lib/email/address";

/** An empty draft addressed to one person, for the composer to open. */
export async function createDraftTo({
	mailboxId,
	from,
	address,
}: {
	mailboxId: string | null;
	from: string;
	address: string;
}): Promise<string> {
	const response = await authFetch("/api/drafts", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		// The API rejects the draft unless `from` matches an address of the mailbox.
		body: JSON.stringify({ mailboxId, from: getEmailAddress(from), to: getEmailAddress(address) }),
	});
	const data = (await response.json()) as { draft?: { id: string }; error?: string };
	if (!response.ok || !data.draft) throw new Error(data.error ?? "Unable to start a new email");
	return data.draft.id;
}
