import { expect, test } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";
import { apiContext, uniqueToken, waitForMessage } from "./support/helpers";
import { startFakeImap } from "../tests/support/fake-imap.mjs";

// Imported HTML over 16 KB is kept in the Mail store, not D1 (src/lib/email/bodies.ts). The reader, the thread and
// search must not notice: tests/message-bodies.test.mjs compares every reader with an inline copy.

function largeHtmlMessage(token: string, { textPart, bodyWord }: { textPart: boolean; bodyWord: string }) {
	const html = [
		`<div><p>Hello from ${token}.</p>`,
		`<p><b>Offloaded paragraph ${token}</b> mentions ${bodyWord}.</p>`,
		`<p>${"The quarterly figures follow in the table below. ".repeat(500)}</p>`,
		"<p>Kind regards, Sam</p></div>",
	].join("");
	const headers = [
		"From: Sam <sam@example.org>",
		"To: user@example.test",
		`Subject: ${token} large newsletter`,
		`Message-ID: <${token}@example.org>`,
		"Date: Tue, 27 Oct 2026 10:00:00 +0000",
		"MIME-Version: 1.0",
	];
	const body = textPart
		? [
				'Content-Type: multipart/alternative; boundary="part"',
				"",
				"--part",
				"Content-Type: text/plain; charset=utf-8",
				"",
				`Hello from ${token}, in plain text.`,
				"--part",
				"Content-Type: text/html; charset=utf-8",
				"",
				html,
				"--part--",
			]
		: ["Content-Type: text/html; charset=utf-8", "", html];
	return [...headers, ...body, ""].join("\r\n");
}

test("a large imported HTML message is shown, threaded and found like any other", async ({ page }) => {
	test.setTimeout(120_000);
	const multipart = uniqueToken("offloadmulti");
	const htmlOnly = uniqueToken("offloadhtml");
	const bodyWord = uniqueToken("bodyword");
	const fake = await startFakeImap({
		authPlain: true,
		folders: {
			INBOX: [
				largeHtmlMessage(multipart, { textPart: true, bodyWord: uniqueToken("unused") }),
				largeHtmlMessage(htmlOnly, { textPart: false, bodyWord }),
			],
		},
	});
	const api = await apiContext(STORAGE_STATE);
	try {
		const { mailboxes } = (await (await api.get("/api/mailboxes")).json()) as { mailboxes: { id: string }[] };
		const imported = await api.post("/api/import/imap", {
			data: {
				host: fake.host,
				port: fake.port,
				secure: false,
				username: "user@example.test",
				password: "app-password",
				mailboxId: mailboxes[0].id,
				folder: "INBOX",
				destination: "system:inbox",
				limit: 10,
			},
		});
		expect(imported.status(), await imported.text()).toBe(200);
		expect(await imported.json()).toMatchObject({ imported: 2 });

		for (const token of [multipart, htmlOnly]) {
			const message = await waitForMessage(api, `${token} large newsletter`);
			const detail = (await (await api.get(`/api/messages/${message.id}`)).json()) as {
				body: { htmlBody: string | null; textBody: string | null };
			};
			expect(detail.body.htmlBody).toContain(`Offloaded paragraph ${token}`);
			// Without a text part the message reads as it was imported: HTML only.
			expect(detail.body.textBody?.trim() ?? null).toBe(
				token === multipart ? `Hello from ${token}, in plain text.` : null,
			);
			const thread = (await (await api.get(`/api/messages/${message.id}/thread`)).json()) as {
				messages: { id: string; htmlBody: string | null }[];
			};
			expect(thread.messages.find((entry) => entry.id === message.id)?.htmlBody).toContain(
				`Offloaded paragraph ${token}`,
			);

			await page.goto(`/inbox/${message.id}`);
			const body = page.frameLocator('iframe[title="Message body"]');
			await expect(body.locator("b", { hasText: `Offloaded paragraph ${token}` })).toBeVisible();
		}

		// Search reads the text the row keeps; for the HTML-only message that is the text of its HTML.
		const found = (await (
			await api.get(`/api/messages?${new URLSearchParams({ q: bodyWord, limit: "5" })}`)
		).json()) as {
			messages: { subject: string | null; snippet: string | null }[];
		};
		expect(found.messages.map((message) => message.subject)).toEqual([`${htmlOnly} large newsletter`]);
		expect(found.messages[0].snippet).toContain(`Hello from ${htmlOnly}`);
	} finally {
		await api.dispose();
		await fake.close();
	}
});
