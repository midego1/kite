import { expect, test, type APIRequestContext } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, openMessage, uniqueToken } from "./support/helpers";

// The reader's sender authentication warning and its thread badge read only signals Kite already
// stores on messages.spam_signals (plus the display-name match the message detail route looks up
// the same way automatic reading does) — nothing here re-checks authentication. Invented domains only.

let api: APIRequestContext;
let mailboxId: string;

test.beforeAll(async () => {
	api = await apiContext(STORAGE_STATE);
	const { mailboxes } = (await (await api.get("/api/mailboxes")).json()) as {
		mailboxes: { id: string; localPart: string; hostname: string }[];
	};
	const mailbox = mailboxes.find((item) => `${item.localPart}@${item.hostname}` === SUPPORT_ADDRESS);
	expect(mailbox, SUPPORT_ADDRESS).toBeDefined();
	mailboxId = mailbox!.id;
});

test.afterAll(async () => {
	await api.dispose();
});

const warningBanner = (page: import("@playwright/test").Page) => page.locator("[data-sender-auth-warning]");
const badge = (page: import("@playwright/test").Page) => page.locator("[data-sender-auth-badge]");

test("failed SPF, DKIM and DMARC are shown as one calm warning, most serious first, with an accessible status role", async ({
	page,
}) => {
	const token = uniqueToken("auth");
	const domain = `${token}.invalid`;
	const subject = `Statement ${token}`;
	await deliverInbound(api, {
		from: `Billing <billing@${domain}>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: "Your statement is attached.",
		headers: {
			"Authentication-Results": `mx.cloudflare.net; spf=fail smtp.mailfrom=bounce@${domain}; dkim=fail header.d=${domain}; dmarc=fail header.from=${domain} policy.dmarc=none`,
		},
	});

	await page.goto("/inbox");
	await openMessage(page, subject);
	const banner = warningBanner(page);
	await expect(banner).toBeVisible();
	await expect(banner).toHaveAttribute("role", "status");
	await expect(banner).toContainText("This sender couldn't be fully verified");
	const items = banner.locator("li");
	await expect(items).toHaveCount(3);
	await expect(items.nth(0)).toContainText("DMARC");
	await expect(items.nth(1)).toContainText("SPF");
	await expect(items.nth(2)).toContainText("DKIM");
	await expect(badge(page)).toBeVisible();
});

test("a plain message with nothing to flag shows neither the warning nor the badge", async ({ page }) => {
	const token = uniqueToken("clean");
	const subject = `Hello ${token}`;
	await deliverInbound(api, {
		from: `Dana <dana-${token}@outside.invalid>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: "Just checking in.",
	});

	await page.goto("/inbox");
	await openMessage(page, subject);
	await expect(warningBanner(page)).toHaveCount(0);
	await expect(badge(page)).toHaveCount(0);
});

test("a cross-domain Reply-To is named without any authentication having failed", async ({ page }) => {
	const token = uniqueToken("replyto");
	const domain = `${token}.invalid`;
	const subject = `Newsletter ${token}`;
	await deliverInbound(api, {
		from: `News <news@${domain}>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: "This week's updates.",
		headers: { "Reply-To": `replies@other-${domain}` },
	});

	await page.goto("/inbox");
	await openMessage(page, subject);
	const banner = warningBanner(page);
	await expect(banner).toBeVisible();
	await expect(banner.locator("li")).toHaveCount(1);
	await expect(banner).toContainText("Replies to this message would go to a different domain");
});

test("a display name reused from a trusted contact is named with the contact it matches", async ({ page }) => {
	const token = uniqueToken("spoof");
	const contactAddress = `maya-${token}@trusted.invalid`;
	const saved = await api.patch("/api/contacts", {
		data: { mailboxId, address: contactAddress, displayName: `Maya Chen ${token}` },
	});
	expect(saved.ok(), await saved.text()).toBe(true);

	const subject = `Invoice ${token}`;
	await deliverInbound(api, {
		from: `Maya Chen ${token} <billing@attacker-${token}.invalid>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: "Please pay the attached invoice.",
	});

	await page.goto("/inbox");
	await openMessage(page, subject);
	const banner = warningBanner(page);
	await expect(banner).toBeVisible();
	await expect(banner).toContainText(contactAddress);
});

test("the thread shows a compact badge for a message with a concern, while a clean open message stays clean", async ({
	page,
}) => {
	const token = uniqueToken("thread");
	const domain = `${token}.invalid`;
	const originalId = `<${token}@${domain}>`;
	await deliverInbound(api, {
		from: `Alex <alex@${domain}>`,
		to: SUPPORT_ADDRESS,
		subject: `Project update ${token}`,
		text: "First message.",
		messageId: originalId,
		headers: {
			"Authentication-Results": `mx.cloudflare.net; spf=fail smtp.mailfrom=bounce@${domain}; dkim=fail header.d=${domain}; dmarc=fail header.from=${domain} policy.dmarc=none`,
		},
	});
	await deliverInbound(api, {
		from: `Alex <alex@${domain}>`,
		to: SUPPORT_ADDRESS,
		subject: `Re: Project update ${token}`,
		text: "Follow-up message, nothing unusual.",
		inReplyTo: originalId,
	});

	await page.goto("/inbox");
	await openMessage(page, `Re: Project update ${token}`);
	// The open (second, clean) message shows nothing of its own.
	await expect(warningBanner(page)).toHaveCount(0);
	// The collapsed first message in the thread still carries its own badge.
	await expect(badge(page)).toHaveCount(1);
});
