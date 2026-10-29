import { expect, test, type APIRequestContext, type Browser } from "@playwright/test";
import { AUTO_READ_ACCOUNT_PASSWORD, createSignedInAccount } from "./support/auto-read";
import { STORAGE_STATE } from "./support/constants";
import { apiContext, openMessage, setSendingSettings, uniqueToken, waitForMessage } from "./support/helpers";
import { chooseOption, readOptions } from "./support/select";
import { startFakeImap } from "../tests/support/fake-imap.mjs";
import { startFakeSmtp } from "../tests/support/fake-smtp.mjs";

// Send-as around the edges (docs/specs/external-accounts.md §7.3, §9.3, PR 10): Undo send never reaches the
// provider, a scheduled send checks the account again when it runs (the install switch went off meanwhile), a
// connection lost after the message went out is shown as "Delivery unknown" and never sent twice, and the send-as part
// of the Connected accounts page in every style.

const APP_PASSWORD = "fake-app-password";
const RECIPIENT = "friend@e2e.test";

type Fakes = { smtp: Awaited<ReturnType<typeof startFakeSmtp>>; imap: Awaited<ReturnType<typeof startFakeImap>> };

async function setUp(prefix: string, smtpOptions: Record<string, unknown> = {}) {
	const token = uniqueToken(prefix);
	const address = `${token}@example.test`;
	const fakes: Fakes = {
		smtp: await startFakeSmtp({ users: { [address]: APP_PASSWORD }, ...smtpOptions }),
		imap: await startFakeImap({ authPlain: true, users: { [address]: APP_PASSWORD } }),
	};
	const admin = await apiContext(STORAGE_STATE);
	const user = await createSignedInAccount(admin, `${prefix.slice(0, 2)}${token.slice(-8)}`);
	const response = await user.api.post("/api/external-accounts", {
		data: {
			address,
			label: `Send-as ${token}`,
			preset: "other",
			mailboxId: user.mailboxId,
			imap: { host: "127.0.0.1", port: fakes.imap.port, security: "starttls" },
			smtp: { host: "127.0.0.1", port: fakes.smtp.port, security: "starttls" },
			password: APP_PASSWORD,
			kitePassword: AUTO_READ_ACCOUNT_PASSWORD,
		},
	});
	expect(response.status(), await response.text()).toBe(201);
	const close = () => Promise.all([fakes.smtp.close(), fakes.imap.close()]);
	return { token, address, fakes, admin, user, close };
}

async function userPage(browser: Browser, api: APIRequestContext) {
	const context = await browser.newContext({ storageState: await api.storageState() });
	return { context, page: await context.newPage() };
}

const sendBody = (address: string, mailboxId: string, subject: string, extra: Record<string, unknown> = {}) => ({
	from: address,
	mailboxId,
	to: [RECIPIENT],
	subject,
	text: "Hello.",
	html: "<p>Hello.</p>",
	...extra,
});

test("Undo send takes the message back before it reaches the provider", async ({ browser }) => {
	test.setTimeout(150_000);
	const { token, address, fakes, user, close } = await setUp("saundo");
	await setSendingSettings(user.api, { previewEnabled: false, undoSeconds: 10 });
	const { context, page } = await userPage(browser, user.api);
	try {
		await page.goto("/inbox");
		await page.getByRole("button", { name: "Compose" }).click();
		await chooseOption(page.getByRole("combobox", { name: "From" }), {
			label: `${address} (via Other IMAP provider)`,
		});
		const to = page.getByLabel("To", { exact: true });
		await to.fill(RECIPIENT);
		await to.press("Enter");
		const subject = `Undone ${token}`;
		await page.getByLabel("Subject").fill(subject);
		await page.getByRole("textbox", { name: "Message body" }).fill("Never mind.");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await page.getByRole("button", { name: "Undo", exact: true }).click();
		// The composer is back with the draft, From still the connected address.
		await expect(page.getByLabel("Subject")).toHaveValue(subject);
		await expect(page.getByRole("combobox", { name: "From" })).toHaveAttribute(
			"data-value",
			`${user.mailboxId}|${address}`,
		);
		await waitForMessage(user.api, subject, { status: "draft" });

		// Sent again without an undo window: exactly one message reaches the provider, so the undone one never did.
		await setSendingSettings(user.api, { previewEnabled: false, undoSeconds: 0 });
		const sent = await user.api.post("/api/send", { data: sendBody(address, user.mailboxId, `Again ${token}`) });
		expect(sent.ok(), await sent.text()).toBe(true);
		expect(fakes.smtp.messages.map((message) => message.raw.toString())).toEqual([
			expect.stringContaining(`Subject: Again ${token}`),
		]);
	} finally {
		await context.close();
		await close();
	}
});

test("a scheduled send checks the account again when it runs and fails once connected accounts are off", async ({
	browser,
}) => {
	test.setTimeout(150_000);
	const { token, address, fakes, admin, user, close } = await setUp("sasched");
	const { context, page } = await userPage(browser, user.api);
	try {
		const subject = `Later ${token}`;
		const scheduledAt = new Date(Date.now() + 4_000).toISOString();
		const response = await user.api.post("/api/send", {
			data: sendBody(address, user.mailboxId, subject, { scheduledAt }),
		});
		expect(response.ok(), await response.text()).toBe(true);
		expect(((await response.json()) as { scheduled?: boolean }).scheduled).toBe(true);
		expect((await admin.put("/api/admin/external-accounts", { data: { enabled: false } })).ok()).toBe(true);

		await waitForMessage(user.api, subject, { status: "failed" });
		expect(fakes.smtp.messages).toHaveLength(0);
		await page.goto("/sent");
		await openMessage(page, subject);
		await expect(page.getByRole("main")).toContainText(
			`Not sent from ${address}. Connected accounts are not available to you right now.`,
		);

		// While the switch is off the address is not offered at all.
		await page.goto("/inbox");
		await page.getByRole("button", { name: "Compose" }).click();
		const labels = (await readOptions(page.getByRole("combobox", { name: "From" }))).map((option) => option.label);
		expect(labels.some((label) => label.includes(address))).toBe(false);
		const refused = await user.api.post("/api/send", { data: sendBody(address, user.mailboxId, `Refused ${token}`) });
		expect(refused.status()).toBe(403);
	} finally {
		await admin.put("/api/admin/external-accounts", { data: { enabled: true } });
		await context.close();
		await close();
	}
});

test("a connection lost after the message went out is 'Delivery unknown' and never sent twice", async ({ browser }) => {
	test.setTimeout(150_000);
	const { token, address, fakes, user, close } = await setUp("saunk", { afterData: "drop" });
	await setSendingSettings(user.api, { previewEnabled: false, undoSeconds: 0 });
	const { context, page } = await userPage(browser, user.api);
	try {
		const subject = `Unknown ${token}`;
		const response = await user.api.post("/api/send", { data: sendBody(address, user.mailboxId, subject) });
		expect(response.status()).toBe(500);
		expect(((await response.json()) as { error: string }).error).toBe(
			"Delivery unknown: check the recipient or the provider's Sent folder before sending again",
		);
		await waitForMessage(user.api, subject, { status: "failed" });
		await page.goto("/sent");
		await openMessage(page, subject);
		await expect(page.getByRole("main")).toContainText("Delivery unknown: check the recipient");
		// Nothing tries it again behind the user's back.
		await expect.poll(() => fakes.smtp.messages.length, { timeout: 5_000 }).toBe(1);
	} finally {
		await context.close();
		await close();
	}
});

test("the send-as part of the Connected accounts page reads in Kite, Kite light, Classic and dark mode", async ({
	browser,
}, testInfo) => {
	test.setTimeout(150_000);
	const { address, user, close } = await setUp("sastyle");
	const variants = [
		{ name: "kite-dark", style: "kite", theme: "dark" },
		{ name: "kite-light", style: "kite", theme: "light" },
		{ name: "lavender-light", style: "lavender", theme: "light" },
		{ name: "classic-light", style: "classic", theme: "light" },
		{ name: "classic-dark", style: "classic", theme: "dark" },
	];
	try {
		for (const variant of variants) {
			const { context, page } = await userPage(browser, user.api);
			try {
				await page.addInitScript(({ style, theme }) => {
					localStorage.setItem("kite-style", style);
					localStorage.setItem("kite-theme", theme);
				}, variant);
				await page.goto("/settings/connected-accounts");
				await expect(page.locator("html")).toHaveAttribute("data-style", variant.style);
				const sending = page.locator(`[data-account-sending="${address}"]`);
				const text = sending.getByText("Save a copy in the provider's Sent folder");
				await expect(text).toBeVisible();
				const [foreground, background] = await text.evaluate((element) => {
					const canvas = document.createElement("canvas").getContext("2d")!;
					const luminance = (color: string) => {
						canvas.clearRect(0, 0, 1, 1);
						canvas.fillStyle = color;
						canvas.fillRect(0, 0, 1, 1);
						const [r, g, b] = canvas.getImageData(0, 0, 1, 1).data;
						return 0.2126 * r + 0.7152 * g + 0.0722 * b;
					};
					let node: Element | null = element;
					let fill = "rgba(0, 0, 0, 0)";
					while (node && /rgba\(0, 0, 0, 0\)|transparent/.test(fill)) {
						fill = getComputedStyle(node).backgroundColor;
						node = node.parentElement;
					}
					return [luminance(getComputedStyle(element).color), luminance(fill)];
				});
				expect(Math.abs(foreground - background), variant.name).toBeGreaterThan(100);
				await page.screenshot({ path: testInfo.outputPath(`send-as-${variant.name}.png`) });
			} finally {
				await context.close();
			}
		}

		// Turning sending off takes the address out of the From menu.
		const { context, page } = await userPage(browser, user.api);
		try {
			await page.goto("/settings/connected-accounts");
			const toggle = page.getByRole("switch", { name: `Send from ${address}` });
			await toggle.click();
			await expect(toggle).not.toBeChecked();
			await expect(page.locator(`[data-account-sending="${address}"]`)).toContainText(
				"Sending from this address is off.",
			);
			await page.goto("/inbox");
			await page.getByRole("button", { name: "Compose" }).click();
			const labels = (await readOptions(page.getByRole("combobox", { name: "From" }))).map((option) => option.label);
			expect(labels.some((label) => label.includes(address))).toBe(false);
		} finally {
			await context.close();
		}
	} finally {
		await close();
	}
});
