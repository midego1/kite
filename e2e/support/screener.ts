import { expect, type APIRequestContext } from "@playwright/test";

export type ScreenerPatch = { enabled?: boolean; mode?: "screener" | "inbox" };

type MailboxRow = { id: string; permission?: string; screener?: { enabled: boolean } | null };

export async function setScreener(api: APIRequestContext, mailboxId: string, patch: ScreenerPatch): Promise<void> {
	const response = await api.patch("/api/screener", { data: { mailboxId, ...patch } });
	expect(response.ok(), `PATCH /api/screener -> ${response.status()} ${await response.text()}`).toBe(true);
}

/**
 * New mailboxes start with the Screener on, which would hold the outside mail most specs deliver to the
 * accounts and mailboxes they create. Those specs test other things, so their mailboxes start with it off.
 */
export async function turnScreenerOff(api: APIRequestContext, mailboxId?: string): Promise<void> {
	if (mailboxId) return setScreener(api, mailboxId, { enabled: false });
	const response = await api.get("/api/mailboxes");
	expect(response.ok(), await response.text()).toBe(true);
	const { mailboxes } = (await response.json()) as { mailboxes: MailboxRow[] };
	for (const mailbox of mailboxes)
		if (mailbox.screener?.enabled && mailbox.permission === "full_access")
			await setScreener(api, mailbox.id, { enabled: false });
}
