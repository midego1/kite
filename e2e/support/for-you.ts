import { expect, type APIRequestContext, type Browser } from "@playwright/test";
import { BASE_URL, DOMAIN } from "./constants";
import { createSignedInAccount, okJson, selectMailbox } from "./auto-read";
import { postInbound, suppressMailboxTour, uniqueToken, waitForMessage } from "./helpers";
import { futureAt, inviteAttachment } from "./invites";
import { waitForFinishedJob } from "./triage";

// Accounts and mail that leave For you suggestions behind, for the specs of the For you card and its preview
// (the suggestions come from the fake model, e2e/support/fake-model.ts, as in 23-auto-agent).

export type ForYouAccount = Awaited<ReturnType<typeof createSignedInAccount>> & { address: string };

/** A new account whose mailbox suggests (automatic reading on, nothing acted on). */
export async function suggestAccount(admin: APIRequestContext, prefix: string): Promise<ForYouAccount> {
	const username = `${prefix}${uniqueToken("")}`;
	const account = await createSignedInAccount(admin, username);
	await okJson(
		await account.api.put("/api/agent/settings", { data: { mailboxId: account.mailboxId, autonomy: "suggest" } }),
	);
	return { ...account, address: `${username}@${DOMAIN}` };
}

async function settled(client: APIRequestContext, mailboxId: string, subject: string) {
	const message = await waitForMessage(client, subject, { status: "received" });
	expect((await waitForFinishedJob(client, mailboxId, message.id, "triage")).status).toBe("completed");
	return message;
}

/** Mail the fake model answers with a reply suggestion; waits for the triage job to finish. */
export async function deliverReply(
	account: ForYouAccount,
	mailboxId: string,
	to: string,
	from: string,
	client: APIRequestContext = account.api,
) {
	const subject = uniqueToken("ccr");
	await postInbound(client, { from, to, subject, text: "Can you confirm the order? [[scenario:question]]" });
	return settled(client, mailboxId, subject);
}

/** Mail with a link that hides its target: the deterministic phishing facts make a phishing suggestion. */
export async function deliverPhishing(account: ForYouAccount, mailboxId: string, to: string) {
	const subject = uniqueToken("ccp");
	await postInbound(account.api, {
		from: "Bank <alerts@bank.test>",
		to,
		subject,
		text: "Please verify your account. [[scenario:fyi]]",
		html: `<p>Please verify your account. [[scenario:fyi]]</p><p><a href="https://login.evil.test/account">https://bank.example.com/account</a></p>`,
	});
	return settled(account.api, mailboxId, subject);
}

/** A calendar invitation from a named organizer, a fortnight out, which makes a calendar_invite suggestion. */
export async function deliverInvite(account: ForYouAccount, mailboxId: string, to: string) {
	const subject = uniqueToken("cci");
	await postInbound(account.api, {
		from: "Alice <alice@partner.test>",
		to,
		subject,
		text: "Please join.",
		attachments: [
			inviteAttachment({ uid: `${uniqueToken("uid")}@partner.test`, start: futureAt(14, 10), summary: "Planning" }),
		],
	});
	return settled(account.api, mailboxId, subject);
}

/** A signed-in browser context for the account, starting on the given mailbox. */
export async function openAs(
	browser: Browser,
	account: ForYouAccount,
	mailboxId: string,
	options: { hasTouch?: boolean; viewport?: { width: number; height: number } } = {},
) {
	const context = await browser.newContext({
		baseURL: BASE_URL,
		storageState: await account.api.storageState(),
		...options,
	});
	const page = await context.newPage();
	await suppressMailboxTour(page);
	await selectMailbox(page, mailboxId);
	return { context, page };
}
