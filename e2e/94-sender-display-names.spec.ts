import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, uniqueToken } from "./support/helpers";

// Received mail's identity (upstream Mailflare #223, #226): every message in the list shows its own From name, a
// name learned from mail never renames the contact, a name the user saved wins, and a reply joins a conversation only
// when its sender takes part in it or passed DMARC. Invented domains only.

let api: APIRequestContext;

test.beforeAll(async () => {
	api = await apiContext(STORAGE_STATE);
});

test.afterAll(async () => {
	await api.dispose();
});

/** The list row for a subject. */
function messageRow(page: Page, subject: string) {
	return page
		.getByRole("main")
		.locator("div.group")
		.filter({ has: page.getByText(subject, { exact: true }) })
		.last();
}

async function threadSubjects(messageId: string): Promise<string[]> {
	const response = await api.get(`/api/messages/${messageId}/thread`);
	expect(response.ok(), await response.text()).toBe(true);
	const data = (await response.json()) as { messages: { subject: string | null }[] };
	return data.messages.map((message) => message.subject ?? "");
}

test("a shared sender address shows each message's own From name, until the user names the contact", async ({
	page,
}) => {
	const token = uniqueToken("names");
	const address = `no-reply-${token}@ashby.invalid`;
	const first = `Application received ${token}`;
	const second = `Interview invite ${token}`;
	const stored = await deliverInbound(api, {
		from: `"PostHog Team" <${address}>`,
		to: SUPPORT_ADDRESS,
		subject: first,
		text: "Thanks for applying.",
	});
	await deliverInbound(api, {
		from: `"LiveKit Hiring Team" <${address}>`,
		to: SUPPORT_ADDRESS,
		subject: second,
		text: "Let's talk.",
	});

	await page.goto("/inbox");
	await expect(messageRow(page, first)).toContainText("PostHog Team");
	await expect(messageRow(page, second)).toContainText("LiveKit Hiring Team");
	await expect(messageRow(page, first)).not.toContainText("LiveKit Hiring Team");

	// The contact kept the first name mail gave it; the later From name did not rename it.
	const params = new URLSearchParams({ mailboxId: stored.mailboxId, address });
	const contact = await api.get(`/api/contacts?${params}`);
	expect(contact.ok(), await contact.text()).toBe(true);
	expect((await contact.json()).contact).toMatchObject({ displayName: "PostHog Team", source: "inbound" });

	// A name the user saves is deliberate and wins on every message.
	const saved = await api.patch("/api/contacts", {
		data: { mailboxId: stored.mailboxId, address, displayName: "Ashby Recruiting" },
	});
	expect(saved.ok(), await saved.text()).toBe(true);
	await page.reload();
	await expect(messageRow(page, first)).toContainText("Ashby Recruiting");
	await expect(messageRow(page, second)).toContainText("Ashby Recruiting");
});

test("a reply joins a conversation only from a participant or with a DMARC pass for its own domain", async () => {
	const token = uniqueToken("join");
	const domain = `${token}.invalid`;
	const rootId = `<${token}-root@${domain}>`;
	const subject = `Plans ${token}`;
	const root = await deliverInbound(api, {
		from: `Alice <alice@${domain}>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: "Shall we meet?",
		messageId: rootId,
	});
	// A stranger who learned the Message-ID cannot slip a message into the conversation.
	const stranger = await deliverInbound(api, {
		from: `Mallory <mallory@other-${domain}>`,
		to: SUPPORT_ADDRESS,
		subject: `Re: ${subject} (stranger)`,
		text: "Here is the update.",
		inReplyTo: rootId,
	});
	// Alice herself, and a list that signs as itself, do join.
	await deliverInbound(api, {
		from: `Alice <alice@${domain}>`,
		to: SUPPORT_ADDRESS,
		subject: `Re: ${subject} (Alice)`,
		text: "Tuesday works.",
		inReplyTo: rootId,
	});
	await deliverInbound(api, {
		from: `Plans list <plans@lists-${domain}>`,
		to: SUPPORT_ADDRESS,
		subject: `Re: ${subject} (list)`,
		text: "Relayed by the list.",
		inReplyTo: rootId,
		headers: {
			"Authentication-Results": `mx.cloudflare.net; dkim=pass header.d=lists-${domain}; dmarc=pass header.from=lists-${domain}`,
		},
	});

	expect(await threadSubjects(root.id)).toEqual([subject, `Re: ${subject} (Alice)`, `Re: ${subject} (list)`]);
	expect(await threadSubjects(stranger.id)).toEqual([`Re: ${subject} (stranger)`]);
});
