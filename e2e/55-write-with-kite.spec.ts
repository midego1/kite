import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { DOMAIN, STORAGE_STATE } from "./support/constants";
import { useFakeProvider } from "./support/agent";
import { createSignedInAccount, okJson, selectMailbox } from "./support/auto-read";
import { startFakeModel } from "./support/fake-model";
import { COMPOSE_SHORTER_BODY, COMPOSE_TRANSLATE_BODY, COMPOSE_WRITE_BODY } from "./support/fake-model-scenarios";
import type { FakeModel, FakeRecordedRequest } from "./support/fake-model-types";
import { contrastBetween } from "./support/contrast";
import { apiContext, openMessage, postInbound, uniqueToken, waitForMessage } from "./support/helpers";

let api: APIRequestContext;
let fake: FakeModel;
let restore: () => Promise<void>;

test.beforeAll(async () => {
	api = await apiContext(STORAGE_STATE);
	fake = await startFakeModel();
	restore = await useFakeProvider(api, fake);
});

test.afterAll(async () => {
	await restore?.();
	await fake?.close();
	await api?.dispose();
});

test.beforeEach(() => {
	fake.clearRequests();
	fake.resetDefaultScenario();
});

const SIGNATURE = "Alex Owner, Treasurer";

type Account = Awaited<ReturnType<typeof createSignedInAccount>> & { address: string };

async function newAccount(prefix: string): Promise<Account> {
	const username = `${prefix}${uniqueToken("")}`;
	const account = await createSignedInAccount(api, username);
	await okJson(await account.api.patch(`/api/mailboxes/${account.mailboxId}`, { data: { signature: SIGNATURE } }));
	return { ...account, address: `${username}@${DOMAIN}` };
}

async function signedInPage(browser: Browser, account: Account) {
	const context = await browser.newContext({ storageState: await account.api.storageState() });
	const page = await context.newPage();
	await selectMailbox(page, account.mailboxId);
	return { context, page };
}

const composeRequests = () => fake.requests().filter((request) => request.kind === "compose");

function userTurn(request: FakeRecordedRequest): string {
	const messages = (request.body as { messages: { role: string; content: string }[] }).messages;
	return messages
		.filter((message) => message.role === "user")
		.map((message) => message.content)
		.join("\n");
}

function systemText(request: FakeRecordedRequest): string {
	const messages = (request.body as { messages: { role: string; content: string }[] }).messages;
	return messages
		.filter((message) => message.role === "system")
		.map((message) => message.content)
		.join("\n");
}

async function openComposer(page: Page) {
	await page.goto("/inbox");
	await page.getByRole("button", { name: "Compose" }).click();
	await expect(page.getByLabel("Subject")).toBeEditable();
	const body = page.getByRole("textbox", { name: "Message body" });
	await expect(body).toContainText(SIGNATURE);
	return body;
}

/** Selects the first text node in the message body that contains `text`, as a user would by dragging over it. */
async function selectInBody(page: Page, text: string) {
	await page.getByRole("textbox", { name: "Message body" }).evaluate((editor, wanted) => {
		const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const index = node.textContent?.indexOf(wanted) ?? -1;
			if (index < 0) continue;
			const range = document.createRange();
			range.setStart(node, index);
			range.setEnd(node, index + wanted.length);
			(editor as HTMLElement).focus();
			const selection = window.getSelection()!;
			selection.removeAllRanges();
			selection.addRange(range);
			return;
		}
		throw new Error(`Text not found: ${wanted}`);
	}, text);
}

async function openPanel(page: Page) {
	await page.getByRole("button", { name: "Write with Kite" }).click();
	const panel = page.getByRole("dialog", { name: "Write with Kite" });
	await expect(panel).toBeVisible();
	return panel;
}

async function typeBody(page: Page, paragraphs: string[]) {
	const body = page.getByRole("textbox", { name: "Message body" });
	await body.click();
	await page.keyboard.press("ControlOrMeta+Home");
	for (const [index, paragraph] of paragraphs.entries()) {
		if (index) await page.keyboard.press("Enter");
		await page.keyboard.type(paragraph);
	}
	return body;
}

test.describe("Write with Kite", () => {
	test("writes from a prompt into a preview, inserts above the signature only on click, and Undo restores", async ({
		browser,
	}) => {
		const account = await newAccount("wwk");
		const { context, page } = await signedInPage(browser, account);
		try {
			const body = await openComposer(page);
			const before = await body.innerHTML();
			const panel = await openPanel(page);
			await panel
				.getByLabel("What should this email say?")
				.fill("Tell Sam Tuesday at ten works [[scenario:compose-write]]");
			await panel.getByRole("button", { name: "Write" }).click();
			await expect(panel.getByRole("region", { name: "Preview" })).toContainText("Tuesday at ten works for me.");
			// Nothing enters the editor before the click.
			expect(await body.innerHTML()).toBe(before);
			await panel.getByRole("button", { name: "Insert", exact: true }).click();
			await expect(body).toContainText("Tuesday at ten works for me.");
			const html = await body.innerHTML();
			expect(html.indexOf("Tuesday at ten")).toBeLessThan(html.indexOf(SIGNATURE));
			expect(html).toContain("<ul><li>Agenda first</li><li>Then the budget</li></ul>");
			expect(html).toMatch(/data-kite-signature="1"/);

			const [request] = composeRequests();
			expect(request.tools).toEqual([]);
			expect(userTurn(request)).toContain("Tell Sam Tuesday at ten works");
			expect(userTurn(request)).not.toContain(SIGNATURE);

			await panel.getByRole("button", { name: "Undo" }).click();
			await expect(body).not.toContainText("Tuesday at ten");
			await expect(body).toContainText(SIGNATURE);
			expect(COMPOSE_WRITE_BODY).toContain("Tuesday at ten works for me.");
		} finally {
			await context.close();
			await account.api.dispose();
		}
	});

	for (const style of ["kite", "lavender", "classic"] as const) {
		for (const theme of ["dark", "light"] as const) {
			test(`the suggested text is readable in ${style} ${theme}`, async ({ browser }, testInfo) => {
				const account = await newAccount(`wwc${style[0]}${theme[0]}`);
				const context = await browser.newContext({ storageState: await account.api.storageState() });
				await context.addInitScript(
					({ style, theme }) => {
						localStorage.setItem("kite-style", style);
						localStorage.setItem("kite-theme", theme);
					},
					{ style, theme },
				);
				const page = await context.newPage();
				try {
					await selectMailbox(page, account.mailboxId);
					await openComposer(page);
					const panel = await openPanel(page);
					await panel
						.getByLabel("What should this email say?")
						.fill("Tell Sam Tuesday at ten works [[scenario:compose-write]]");
					await panel.getByRole("button", { name: "Write" }).click();
					const preview = panel.getByRole("region", { name: "Preview" });
					await expect(preview).toContainText("Tuesday at ten works for me.");
					await expect(panel.getByRole("button", { name: "Insert", exact: true })).toBeVisible();
					await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /light/);
					// WCAG AA for normal text: the preview's own colours against each other, and its box against the panel.
					expect(await contrastBetween(preview)).toBeGreaterThanOrEqual(4.5);
					expect(await contrastBetween(preview, panel)).toBeGreaterThan(1.05);
					if (theme === "dark") {
						// The old preview was near-white in dark mode; the box must now be darker than its text.
						const [text, background] = await preview.evaluate((element) => {
							const style = getComputedStyle(element);
							return [style.color, style.backgroundColor];
						});
						const lightness = (color: string) => Number(color.match(/\d+/g)?.[0] ?? 0);
						expect(lightness(background)).toBeLessThan(lightness(text));
					}
					await page.screenshot({ path: testInfo.outputPath(`write-with-kite-${style}-${theme}.png`) });
				} finally {
					await context.close();
					await account.api.dispose();
				}
			});
		}
	}

	test("a reply uses the email the server loads, never the folded quote, and the quote stays untouched", async ({
		browser,
	}) => {
		const account = await newAccount("wwq");
		const token = uniqueToken("quote");
		await postInbound(account.api, {
			from: "Sam Partner <sam@partner.test>",
			to: account.address,
			subject: `Planning ${token}`,
			text: `Can we meet on Tuesday? Reference ${token}.`,
			messageId: `<${token}@partner.test>`,
		});
		await waitForMessage(account.api, `Planning ${token}`);
		const { context, page } = await signedInPage(browser, account);
		try {
			await page.goto("/inbox");
			await openMessage(page, `Planning ${token}`);
			await page
				.getByRole("button", { name: /^Reply( \(r\))?$/ })
				.first()
				.click();
			const body = page.getByRole("textbox", { name: "Message body" });
			await expect(body).toBeVisible();
			await page.getByRole("button", { name: "Show quoted text" }).click();
			const quote = page.locator('button[aria-label="Hide quoted text"] + div');
			await expect(quote).toContainText(token);
			const quoteBefore = await quote.innerHTML();

			const panel = await openPanel(page);
			await panel.getByLabel("What should this email say?").fill("Say yes");
			await panel.getByRole("button", { name: "Write" }).click();
			await panel.getByRole("button", { name: "Insert", exact: true }).click();
			await expect(body).toContainText("Tuesday at ten works for me.");
			expect(await quote.innerHTML()).toBe(quoteBefore);
			await expect(body).not.toContainText(token);

			const content = userTurn(composeRequests()[0]);
			expect(content).toMatch(
				new RegExp(`<<<EMAIL id=msg_[\\w-]+ nonce=\\w+>>>[\\s\\S]*Reference ${token}\\.[\\s\\S]*<<<END \\w+>>>`),
			);
			expect(content.split(`Reference ${token}.`).length - 1).toBe(1);
			expect(content).not.toMatch(/kite-quote|<div|wrote:/);
		} finally {
			await context.close();
			await account.api.dispose();
		}
	});

	test("in a reply docked under the message the panel and its preview show in full", async ({ browser }) => {
		const account = await newAccount("wwi");
		const token = uniqueToken("inline");
		await postInbound(account.api, {
			from: "Sam Partner <sam@partner.test>",
			to: account.address,
			subject: `Docked ${token}`,
			text: `Shall we meet on Tuesday? Reference ${token}.`,
		});
		await waitForMessage(account.api, `Docked ${token}`);
		const { context, page } = await signedInPage(browser, account);
		try {
			await page.setViewportSize({ width: 1280, height: 720 });
			await page.goto("/inbox");
			await openMessage(page, `Docked ${token}`);
			await page
				.getByRole("button", { name: /^Reply( \(r\))?$/ })
				.first()
				.click();
			const composer = page.getByRole("main").getByRole("region", { name: "Compose message" });
			await expect(composer.getByRole("button", { name: "Pop out composer" })).toBeVisible();
			const panel = await openPanel(page);
			await panel.getByLabel("What should this email say?").fill("Say yes [[scenario:compose-write]]");
			await panel.getByRole("button", { name: "Write" }).click();
			const preview = panel.getByRole("region", { name: "Preview" });
			await expect(preview).toContainText("Tuesday at ten works for me.");
			// Nothing clips the panel: its corners and the preview are on screen and are what is drawn there.
			for (const target of [panel, preview, panel.getByRole("button", { name: "Insert", exact: true })]) {
				const box = (await target.boundingBox())!;
				expect(box.y).toBeGreaterThanOrEqual(0);
				expect(box.y + box.height).toBeLessThanOrEqual(720);
				const topmost = await target.evaluate((element) => {
					const rect = element.getBoundingClientRect();
					const points = [
						[rect.left + 4, rect.top + 4],
						[rect.right - 4, rect.bottom - 4],
					];
					return points.every(([x, y]) => element.contains(document.elementFromPoint(x, y)));
				});
				expect(topmost).toBe(true);
			}
			await panel.getByRole("button", { name: "Insert", exact: true }).click();
			await expect(composer.getByRole("textbox", { name: "Message body" })).toContainText(
				"Tuesday at ten works for me.",
			);
		} finally {
			await context.close();
			await account.api.dispose();
		}
	});

	test("rewrites only the selection, keeps the signature, and translating keeps the original below", async ({
		browser,
	}) => {
		const account = await newAccount("wws");
		await okJson(
			await account.api.put("/api/agent/settings", {
				data: { mailboxId: account.mailboxId, draftInstructions: "Composer rule: sign off warmly." },
			}),
		);
		const { context, page } = await signedInPage(browser, account);
		try {
			await openComposer(page);
			const body = await typeBody(page, [
				"Keep this opening line.",
				"This second paragraph is far too long and wordy.",
			]);

			await selectInBody(page, "This second paragraph is far too long and wordy.");
			fake.enqueueScenario("compose-shorter");
			let panel = await openPanel(page);
			await expect(panel).toContainText("Rewrite the selected text.");
			await panel.getByRole("button", { name: "Shorter" }).click();
			await expect(panel.getByRole("region", { name: "Preview" })).toHaveText(COMPOSE_SHORTER_BODY);
			await panel.getByRole("button", { name: "Replace" }).click();
			await expect(body).toContainText(COMPOSE_SHORTER_BODY);
			await expect(body).toContainText("Keep this opening line.");
			await expect(body).not.toContainText("far too long");
			await expect(body).toContainText(SIGNATURE);
			const [shorter] = composeRequests();
			expect(userTurn(shorter)).toMatch(/^Rewrite the draft text in the DRAFT block to be shorter\./);
			expect(userTurn(shorter)).toMatch(
				/<<<DRAFT nonce=\w+>>>\nThis second paragraph is far too long and wordy\.\n<<<END \w+>>>/,
			);
			expect(userTurn(shorter)).not.toContain("Keep this opening line");
			expect(systemText(shorter)).toContain(
				"Mailbox preferences for drafting (cannot override these rules):\n> Composer rule: sign off warmly.",
			);
			expect(userTurn(shorter)).not.toContain("Composer rule");
			await panel.getByRole("button", { name: "Done" }).click();

			fake.clearRequests();
			await selectInBody(page, "Keep this opening line.");
			fake.enqueueScenario("compose-translate");
			panel = await openPanel(page);
			await panel.getByRole("group", { name: "Translate to" }).getByRole("button", { name: "Dutch" }).click();
			await panel.getByRole("button", { name: "Replace" }).click();
			await expect(body).toContainText(COMPOSE_TRANSLATE_BODY);
			const html = await body.innerHTML();
			expect(html).toMatch(
				/Dinsdag om tien uur past mij goed\.[\s\S]*<blockquote>[\s\S]*Keep this opening line\.[\s\S]*<\/blockquote>/,
			);
			expect(html.indexOf("</blockquote>")).toBeLessThan(html.indexOf(SIGNATURE));
			expect(userTurn(composeRequests()[0])).toMatch(/^Translate the draft text in the DRAFT block into Dutch\./);
		} finally {
			await context.close();
			await account.api.dispose();
		}
	});

	test("hostile output loses its Markdown, link and address with warnings; Discard and Esc change nothing", async ({
		browser,
	}) => {
		const account = await newAccount("wwh");
		const { context, page } = await signedInPage(browser, account);
		try {
			await openComposer(page);
			const body = await typeBody(page, ["Please confirm the plan."]);
			const before = await body.innerHTML();

			fake.enqueueScenario("compose-hostile");
			let panel = await openPanel(page);
			await panel.getByRole("button", { name: "Fix spelling and grammar" }).click();
			await expect(panel.getByText("A link that is not in your text or the conversation was removed.")).toBeVisible();
			await expect(
				panel.getByText("An email address that is not in your text or the conversation was removed."),
			).toBeVisible();
			const preview = panel.getByRole("region", { name: "Preview" });
			await expect(preview).not.toContainText("evil.test");
			await expect(preview).not.toContainText("**");
			await expect(preview).not.toContainText("##");
			await panel.getByRole("button", { name: "Discard" }).click();
			await expect(panel).toHaveCount(0);
			expect(await body.innerHTML()).toBe(before);

			fake.enqueueScenario("compose-meta");
			panel = await openPanel(page);
			await panel.getByRole("button", { name: "Shorter" }).click();
			await expect(panel.getByRole("alert")).toHaveText(
				"The AI's answer wasn't usable: it was a note about the text instead of the text. Try again.",
			);
			await panel.getByText("Details").click();
			await expect(panel.locator('[data-ai-error="unusable_answer"]')).toContainText("Codeunusable_answer");
			await expect(panel.getByRole("button", { name: "Try again" })).toBeVisible();
			await page.keyboard.press("Escape");
			await expect(panel).toHaveCount(0);
			// Esc closed the panel, not the composer, and nothing was inserted or sent.
			await expect(page.getByLabel("Subject")).toBeVisible();
			expect(await body.innerHTML()).toBe(before);
		} finally {
			await context.close();
			await account.api.dispose();
		}
	});

	test("over the mailbox's spend cap the panel says which cap and nothing reaches the model", async ({ browser }) => {
		const account = await newAccount("wwc");
		await okJson(
			await account.api.put("/api/agent/settings", { data: { mailboxId: account.mailboxId, dailySpendCapMicros: 0 } }),
		);
		const { context, page } = await signedInPage(browser, account);
		try {
			await openComposer(page);
			const panel = await openPanel(page);
			await panel.getByLabel("What should this email say?").fill("Anything");
			await panel.getByRole("button", { name: "Write" }).click();
			await expect(panel.getByRole("alert")).toHaveText(
				/^Daily AI spend cap reached: this mailbox's \$0\.00 for today is used up\. It resets at 00:00 UTC\./,
			);
			expect(composeRequests()).toHaveLength(0);
		} finally {
			await context.close();
			await account.api.dispose();
		}
	});

	test("without the external-provider opt-in, or with the assistant off, there is no button and the API refuses", async ({
		browser,
	}) => {
		const account = await newAccount("wwo");
		const { context, page } = await signedInPage(browser, account);
		const write = { mailboxId: account.mailboxId, mode: "write", instruction: "Hello" };
		try {
			await okJson(await api.put("/api/admin/agent", { data: { externalAutoReadAllowed: false } }));
			await openComposer(page);
			await expect(page.getByRole("button", { name: "Write with Kite" })).toHaveCount(0);
			const refused = await account.api.post("/api/agent/compose", { data: write });
			expect(refused.status()).toBe(403);
			expect(await refused.json()).toMatchObject({ code: "external_provider_not_allowed" });
			expect(await okJson(await account.api.get(`/api/agent/compose?mailboxId=${account.mailboxId}`))).toEqual({
				available: false,
				reason: "external_provider_not_allowed",
			});

			await okJson(await api.put("/api/admin/agent", { data: { externalAutoReadAllowed: true } }));
			await okJson(await api.put("/api/admin/agent", { data: { enabled: false } }));
			const disabled = await account.api.post("/api/agent/compose", { data: write });
			expect(disabled.status()).toBe(403);
			expect(await disabled.json()).toMatchObject({ code: "assistant_off" });
			expect(composeRequests()).toHaveLength(0);

			const anonymous = await apiContext();
			expect((await anonymous.post("/api/agent/compose", { data: write })).status()).toBe(401);
			await anonymous.dispose();
		} finally {
			await api.put("/api/admin/agent", { data: { enabled: true } });
			await api.put("/api/admin/agent", { data: { externalAutoReadAllowed: true } });
			await context.close();
			await account.api.dispose();
		}
	});

	test("⌘J and Ctrl+J open the panel from the body, and Undo after replacing a selection restores it", async ({
		browser,
	}) => {
		const account = await newAccount("wwu");
		const { context, page } = await signedInPage(browser, account);
		try {
			await openComposer(page);
			const body = await typeBody(page, ["First line stays.", "This line will be shortened by Kite."]);
			const panel = page.getByRole("dialog", { name: "Write with Kite" });
			for (const shortcut of ["Meta+j", "Control+j"]) {
				await body.click();
				await page.keyboard.press(shortcut);
				await expect(panel).toBeVisible();
				await expect(panel).toHaveAttribute("aria-modal", "true");
				await page.keyboard.press("Escape");
				await expect(panel).toHaveCount(0);
				// Focus returns to the message body.
				await expect(body).toBeFocused();
			}

			const before = await body.innerHTML();
			await selectInBody(page, "This line will be shortened by Kite.");
			fake.enqueueScenario("compose-shorter");
			await page.keyboard.press("ControlOrMeta+j");
			await panel.getByRole("button", { name: "Shorter" }).click();
			await expect(panel.getByRole("status").filter({ hasText: "Kite's text is ready" })).toBeAttached();
			await panel.getByRole("button", { name: "Replace" }).click();
			await expect(body).toContainText(COMPOSE_SHORTER_BODY);
			await expect(body).not.toContainText("shortened by Kite");
			await panel.getByRole("button", { name: "Undo" }).click();
			await expect(body).toContainText("This line will be shortened by Kite.");
			await expect(body).not.toContainText(COMPOSE_SHORTER_BODY);
			expect(await body.innerHTML()).toBe(before);
		} finally {
			await context.close();
			await account.api.dispose();
		}
	});

	test("a user who sends too many requests in a minute gets 429", async () => {
		const account = await newAccount("wwr");
		try {
			let limited = false;
			// Each refused body still counts against the per-user limit (120 a minute), which runs first. The window is
			// fixed, so 130 requests can straddle two windows without passing 120 in either; 250 cannot.
			for (let attempt = 0; attempt < 250 && !limited; attempt++) {
				const response = await account.api.post("/api/agent/compose", { data: { mailboxId: account.mailboxId } });
				if (response.status() === 429) limited = true;
				else expect(response.status()).toBe(400);
			}
			expect(limited).toBe(true);
			expect(composeRequests()).toHaveLength(0);
		} finally {
			await account.api.dispose();
		}
	});
});
