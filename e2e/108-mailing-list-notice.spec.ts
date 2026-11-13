import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { DOMAIN, STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, openMessage, uniqueToken } from "./support/helpers";
import { createSharedMailbox, createSignedInAccount, shareMailbox } from "./support/auto-read";

// The reader's mailing-list notice (ported from upstream Mailflare #279) and Kite's RFC 8058 one-click unsubscribe.
// The one-click POST goes to a receiver on 127.0.0.1, which UNSUBSCRIBE_ALLOW_LOOPBACK (playwright.config.ts) lets
// through outside production; nothing leaves the machine. Invented domains only.

type Received = { path: string; method: string; contentType: string; body: string };

let api: APIRequestContext;
let server: Server;
let origin: string;
const received: Received[] = [];
/** The status the receiver answers, per path. */
const answers = new Map<string, number>();

test.beforeAll(async () => {
	api = await apiContext(STORAGE_STATE);
	server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => (body += chunk));
		request.on("end", () => {
			const path = request.url ?? "/";
			received.push({
				path,
				method: request.method ?? "",
				contentType: request.headers["content-type"] ?? "",
				body,
			});
			response.writeHead(answers.get(path) ?? 200, { "Content-Type": "text/html" });
			response.end("<p>You are unsubscribed.</p>");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
	await api.dispose();
	await new Promise((resolve) => server.close(resolve));
});

const notice = (page: Page) => page.getByRole("region", { name: "Mailing list" });

/** Headers of a list message; `oneClick` adds RFC 8058's Post header, a DKIM signature over both and a DKIM pass. */
function listHeaders(token: string, options: { listName?: string; oneClick?: boolean; path?: string } = {}) {
	const domain = `${token}.invalid`;
	const url = `${origin}${options.path ?? `/u/${token}`}`;
	return {
		"List-Id": `${options.listName ?? "Weekly News"} <news.${domain}>`,
		"List-Unsubscribe": `<mailto:leave@${domain}>, <${url}>`,
		...(options.oneClick
			? {
					"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
					"DKIM-Signature": `v=1; a=rsa-sha256; d=${domain}; s=s1; h=From:To:Subject:List-Unsubscribe:List-Unsubscribe-Post; bh=x; b=y`,
					"Authentication-Results": `mx.cloudflare.net; dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`,
				}
			: {}),
	};
}

async function deliverList(
	token: string,
	subject: string,
	options: Parameters<typeof listHeaders>[1] = {},
	to = SUPPORT_ADDRESS,
) {
	return deliverInbound(api, {
		from: `Weekly News <news@${token}.invalid>`,
		to,
		subject,
		text: "This week's stories.",
		headers: listHeaders(token, options),
	});
}

test("a signed one-click list is left from the notice: Kite sends the RFC 8058 POST after a confirmation", async ({
	page,
}) => {
	const token = uniqueToken("oneclick");
	const subject = `Weekly digest ${token}`;
	await deliverList(token, subject, { oneClick: true, listName: `Kite Weekly ${token}` });

	await page.goto("/inbox");
	await openMessage(page, subject);
	const box = notice(page);
	await expect(box).toBeVisible();
	await expect(box).toContainText(`This message is from the mailing list`);
	await expect(box).toContainText(`Kite Weekly ${token}`);
	await expect(box.locator("p[dir=auto]").first()).toBeVisible();

	await box.getByRole("button", { name: "Unsubscribe" }).click();
	const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog"));
	await expect(dialog).toContainText("Unsubscribe from this list?");
	await dialog.getByRole("button", { name: "Unsubscribe" }).click();

	await expect(box).toContainText("You're unsubscribed.");
	await expect(box.getByRole("button", { name: "Unsubscribe" })).toHaveCount(0);
	const posts = received.filter((request) => request.path === `/u/${token}`);
	expect(posts).toEqual([
		{
			path: `/u/${token}`,
			method: "POST",
			contentType: "application/x-www-form-urlencoded",
			body: "List-Unsubscribe=One-Click",
		},
	]);

	// A second request for the same message within the cooldown is refused on the server and sends nothing.
	const message = await (await api.get(`/api/messages?${new URLSearchParams({ q: subject, limit: "1" })}`)).json();
	const again = await api.post(`/api/messages/${message.messages[0].id}/unsubscribe`);
	expect(again.status()).toBe(429);
	expect((await again.json()).code).toBe("ALREADY_REQUESTED");
	expect(received.filter((request) => request.path === `/u/${token}`)).toHaveLength(1);
});

test("when the sender's endpoint fails, the notice says so and offers the sender's own page", async ({ page }) => {
	const token = uniqueToken("fails");
	const subject = `Weekly digest ${token}`;
	answers.set(`/u/${token}`, 500);
	await deliverList(token, subject, { oneClick: true });

	await page.goto("/inbox");
	await openMessage(page, subject);
	const box = notice(page);
	await box.getByRole("button", { name: "Unsubscribe" }).click();
	await page.getByRole("button", { name: "Unsubscribe" }).last().click();
	await expect(box).toContainText("Kite couldn't unsubscribe you automatically.");
	const link = box.getByRole("link", { name: "Open the unsubscribe page" });
	await expect(link).toHaveAttribute("href", `${origin}/u/${token}`);
	await expect(link).toHaveAttribute("rel", "noopener noreferrer");
});

test("without a DKIM signature over the headers, Unsubscribe opens the link instead and Kite posts nothing", async ({
	page,
}) => {
	const token = uniqueToken("unsigned");
	const subject = `Weekly digest ${token}`;
	const message = await deliverInbound(api, {
		from: `Weekly News <news@${token}.invalid>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: "This week's stories.",
		// Asks for one-click, but nothing signs the headers: RFC 8058 §4 says not to POST.
		headers: { ...listHeaders(token), "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
	});
	const detail = await (await api.get(`/api/messages/${message.id}`)).json();
	expect(detail.mailingList).toEqual({ id: `news.${token}.invalid`, name: "Weekly News", oneClick: false });
	const refused = await api.post(`/api/messages/${message.id}/unsubscribe`);
	expect(refused.status()).toBe(409);
	expect((await refused.json()).url).toBe(`${origin}/u/${token}`);

	await page.goto("/inbox");
	await openMessage(page, subject);
	const popup = page.waitForEvent("popup");
	await notice(page).getByRole("button", { name: "Unsubscribe" }).click();
	await expect(await popup).toHaveURL(`${origin}/u/${token}`);
	expect(received.some((request) => request.path === `/u/${token}` && request.method === "POST")).toBe(false);
});

test("closing the notice hides it for that list in this browser, with Undo, and keyboard focus stays in the reader", async ({
	page,
}) => {
	const token = uniqueToken("dismiss");
	const first = `First issue ${token}`;
	const second = `Second issue ${token}`;
	const other = uniqueToken("other");
	const otherSubject = `Other list ${other}`;
	await deliverList(token, first);
	await deliverList(token, second);
	await deliverList(other, otherSubject);

	await page.goto("/inbox");
	await openMessage(page, first);
	const close = notice(page).getByRole("button", { name: "Hide this notice for this list" });
	await close.focus();
	await page.keyboard.press("Enter");
	await expect(notice(page)).toHaveCount(0);
	await expect(page.locator("[data-reader-scroll]")).toBeFocused();
	await expect(page.getByText("The notice is hidden for this list")).toBeVisible();

	// The same list stays hidden after a reload; another list still shows its notice.
	await page.goto("/inbox");
	await openMessage(page, second);
	await expect(page.locator("[data-reader-scroll]").getByText(`news@${token}.invalid`).first()).toBeVisible();
	await expect(notice(page)).toHaveCount(0);
	await page.goto("/inbox");
	await openMessage(page, otherSubject);
	await expect(notice(page)).toBeVisible();

	// Undo brings it back.
	await notice(page).getByRole("button", { name: "Hide this notice for this list" }).click();
	await expect(notice(page)).toHaveCount(0);
	await page.getByRole("button", { name: "Undo" }).click();
	await expect(notice(page)).toBeVisible();

	// Malformed storage reads as nothing hidden, never a broken reader.
	await page.evaluate(() => localStorage.setItem("kite-mailing-list-notice-dismissed", "{not json"));
	await page.goto("/inbox");
	await openMessage(page, first);
	await expect(notice(page)).toBeVisible();
});

test("spam and Trash never show the notice, and one-click is refused for both", async ({ page }) => {
	const token = uniqueToken("spam");
	const spamSubject = `Weekly digest ${token}`;
	const spam = await deliverList(token, spamSubject, { oneClick: true });
	const trashToken = uniqueToken("trash");
	const trashSubject = `Weekly digest ${trashToken}`;
	const trash = await deliverList(trashToken, trashSubject, { oneClick: true });
	for (const [id, action] of [
		[spam.id, "spam"],
		[trash.id, "trash"],
	] as const) {
		const moved = await api.post("/api/messages/bulk", { data: { messageIds: [id], action } });
		expect(moved.ok(), await moved.text()).toBe(true);
	}

	const spamDetail = await (await api.get(`/api/messages/${spam.id}`)).json();
	expect(spamDetail.mailingList.oneClick).toBe(false);
	const trashDetail = await (await api.get(`/api/messages/${trash.id}`)).json();
	expect(trashDetail.mailingList.oneClick).toBe(false);
	expect((await api.post(`/api/messages/${trash.id}/unsubscribe`)).status()).toBe(409);
	expect(received.some((request) => request.path === `/u/${trashToken}`)).toBe(false);
	expect((await api.post(`/api/messages/${spam.id}/unsubscribe`)).status()).toBe(409);
	expect(received.some((request) => request.path === `/u/${token}`)).toBe(false);

	// The reader shows the sender line once the message is loaded; the notice would render in the same pass.
	await page.goto(`/spam/${spam.id}`);
	await expect(page.locator("[data-reader-scroll]").getByText(`news@${token}.invalid`).first()).toBeVisible();
	await expect(notice(page)).toHaveCount(0);
	await page.goto(`/trash/${trash.id}`);
	await expect(page.locator("[data-reader-scroll]").getByText(`news@${trashToken}.invalid`).first()).toBeVisible();
	await expect(notice(page)).toHaveCount(0);
});

test("a delegate with read-only access sees the notice but cannot have Kite unsubscribe the mailbox", async () => {
	const token = uniqueToken("delegate");
	const localPart = `lists${token}`;
	const sharedMailboxId = await createSharedMailbox(api, localPart);
	const delegate = await createSignedInAccount(api, `reader${token}`);
	await shareMailbox(api, sharedMailboxId, delegate.id, "read_only");
	const message = await deliverList(token, `Weekly digest ${token}`, { oneClick: true }, `${localPart}@${DOMAIN}`);

	const ownerView = await (await api.get(`/api/messages/${message.id}`)).json();
	expect(ownerView.mailingList?.oneClick, JSON.stringify(ownerView.mailingList)).toBe(true);
	const delegateView = await (await delegate.api.get(`/api/messages/${message.id}`)).json();
	expect(delegateView.mailingList.oneClick).toBe(false);
	expect((await delegate.api.post(`/api/messages/${message.id}/unsubscribe`)).status()).toBe(403);
	expect(received.some((request) => request.path === `/u/${token}`)).toBe(false);
	await delegate.api.dispose();
});
