import { expect, test, type APIRequestContext } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, postInbound, uniqueToken, waitForMessage } from "./support/helpers";

// The authentication policy end to end, through the local Email Routing handler: Cloudflare's own
// Authentication-Results is the topmost copy, so it counts. Invented domains only.

let api: APIRequestContext;

test.beforeAll(async () => {
	api = await apiContext(STORAGE_STATE);
});

test.afterAll(async () => {
	await api.put("/api/admin/spam-policy", { data: { strictDmarc: false } });
	await api.dispose();
});

const dmarcFail = (domain: string, policy: string) =>
	`mx.cloudflare.net; spf=fail smtp.mailfrom=bounce@${domain}; dkim=none; dmarc=fail header.from=${domain} policy.dmarc=${policy}`;

async function deliver(policy: string, token: string): Promise<string> {
	const domain = `${token}.invalid`;
	const subject = `Invoice ${policy} ${token}`;
	await postInbound(api, {
		from: `Billing <billing@${domain}>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: "Your invoice is attached. Thanks for your business.",
		headers: { "Authentication-Results": dmarcFail(domain, policy) },
	});
	return subject;
}

test("DMARC failures follow the sender's published policy and the Admin switch", async ({ page }) => {
	const token = uniqueToken("dmarc");

	// p=reject goes to Spam; p=none only adds points and stays in the Inbox.
	const rejected = await deliver("reject", token);
	const spam = await waitForMessage(api, rejected, { status: "spam" });
	expect(spam.subject).toContain(rejected);
	const monitored = await deliver("none", token);
	await waitForMessage(api, monitored);

	await page.goto("/general");
	const card = page.locator("[data-sender-authentication]");
	const toggle = card.getByRole("switch", { name: "Treat every DMARC failure as spam" });
	await expect(toggle).not.toBeChecked();
	await expect(card).toContainText("reject or quarantine");
	await toggle.click();
	await expect(toggle).toBeChecked();
	expect(await (await api.get("/api/admin/spam-policy")).json()).toEqual({
		strictDmarc: true,
		migrationPending: false,
	});

	try {
		// With the switch on, a p=none failure goes to Spam too.
		const strict = await deliver("none", `${token}s`);
		await waitForMessage(api, strict, { status: "spam" });
	} finally {
		await toggle.click();
		await expect(toggle).not.toBeChecked();
	}
	expect((await (await api.get("/api/admin/spam-policy")).json()).strictDmarc).toBe(false);
});
