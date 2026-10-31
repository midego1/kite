import { expect, test, type Page } from "@playwright/test";
import { mockAssistant } from "./support/assistant-mock";
import { createSignedInAccount, okJson } from "./support/auto-read";
import { ADMIN, DOMAIN, STORAGE_STATE } from "./support/constants";
import { sql } from "./support/drive";
import { apiContext, uniqueToken } from "./support/helpers";

// Why? next to "N AI requests failed" (src/components/agent/ai-failures-why.tsx): the last day's `ai.error` rows
// grouped by code with a cause, a fix and a settings link, worked out without a model, and Ask AI, which hands a
// summary to the assistant's input. The rows are seeded two hours back, so the newest-first lists other specs
// read stay theirs.

const model = uniqueToken("why-model-");
// A Claude model that thinks by default, cut off with a saved effort: Why? states the recorded budget.
const claude = `claude-haiku-5-5-${model}`;
const REPORT_API = "**/api/admin/agent/errors/report";

function seedFailures() {
	const at = Math.floor(Date.now() / 1000) - 2 * 60 * 60;
	const budget = {
		cap: 1_500,
		thinkingRoom: 1_100,
		extensionRoom: 0,
		thinking: "on",
		effort: "medium",
		retried: false,
		used: 1_500,
		thinkingUsed: 1_460,
	};
	const rows = [
		{ code: "provider_auth", feature: "auto_triage", status: 401 },
		{ code: "provider_auth", feature: "auto_triage", status: 401 },
		{ code: "provider_auth", feature: "summary", status: 401 },
		{ code: "timeout", feature: "summary", status: null },
		{ code: "cut_off", feature: "auto_triage", status: null, model: claude, provider: "anthropic", budget },
	].map(({ code, feature, status, ...extra }, index) => {
		const metadata = JSON.stringify({ code, feature, model, provider: "openai", status, durationMs: 10, ...extra });
		return `('${uniqueToken("aud_")}', 'ai.error', '${metadata}', ${at + index})`;
	});
	sql(`INSERT INTO audit_logs (id, action, metadata, created_at) VALUES ${rows.join(", ")}`);
}

test.beforeAll(() => seedFailures());
test.afterAll(() => sql(`DELETE FROM audit_logs WHERE action = 'ai.error' AND metadata LIKE '%${model}%'`));

test.afterEach(async ({ page }) => {
	await page.unrouteAll({ behavior: "ignoreErrors" });
});

/** Answers the report with `assistant` replaced, so Ask AI's two states do not depend on the install's provider. */
async function withAssistant(page: Page, assistant: Record<string, unknown>) {
	await page.route(REPORT_API, async (route) => {
		const response = await route.fetch();
		const body = (await response.json()) as Record<string, unknown>;
		await route.fulfill({ response, json: { ...body, assistant } });
	});
}

async function openWhy(page: Page, item: ReturnType<Page["getByTestId"]>) {
	await item.getByRole("button", { name: "Why?" }).click();
	const dialog = page.getByRole("dialog", { name: "Why AI requests failed" });
	await expect(dialog).toBeVisible();
	return dialog;
}

test("Why? on the admin overview groups the failures with a cause, a fix and a settings link", async ({ page }) => {
	await page.goto("/admin");
	const item = page.getByTestId("attention-ai-errors");
	await expect(item).toContainText(/AI requests? failed in the last 24 hours/);
	const dialog = await openWhy(page, item);
	const auth = dialog.locator('[data-ai-failure-group="provider_auth"]');
	await expect(auth).toContainText(/\d+ failures/);
	await expect(auth).toContainText("OpenAI refused Kite's API key (HTTP 401)");
	await expect(auth).toContainText(`OpenAI · ${model}`);
	await expect(auth).toContainText("Automatic reading");
	await expect(auth).toContainText("The AI provider did not accept Kite's API key (HTTP 401).");
	await expect(auth.getByRole("link", { name: "Open AI provider settings" })).toHaveAttribute(
		"href",
		"/agent#ai-provider",
	);
	await expect(dialog.locator('[data-ai-failure-group="timeout"]')).toContainText("pick a faster model");
	// A cut-off answer lists the facts Kite recorded. Other specs' cut-off rows (summaries, triage) may be newer
	// than this seeded one and supply the quoted budget, so the rows are checked and the wording is unit-tested.
	const cutOff = dialog.locator('[data-ai-failure-group="cut_off"]');
	await expect(cutOff).toContainText(claude);
	for (const label of ["Output cap", "Thinking", "Used", "Retry"])
		await expect(cutOff.locator("dt", { hasText: label })).toBeVisible();
	await expect(cutOff.locator("dt", { hasText: "Output cap" }).locator("+ dd")).toHaveText(/^[\d,]+ tokens/);
	await expect(cutOff).toContainText(/capped \S+'s answer at [\d,]+ tokens/);
	// Nobody is named: no account, no mailbox.
	await expect(dialog).not.toContainText(ADMIN.email);
	await expect(dialog).not.toContainText(`@${DOMAIN}`);

	// The settings link lands on the provider card of Admin → Agent.
	await auth.getByRole("link", { name: "Open AI provider settings" }).click();
	await expect(page).toHaveURL(/\/agent#ai-provider$/);
	await expect(page.locator("#ai-provider")).toBeAttached();
});

test("Ask AI from the overview opens the mailbox's assistant with the summary, unsent", async ({ page }) => {
	await mockAssistant(page);
	await withAssistant(page, { available: true });
	const chats: string[] = [];
	page.on("request", (request) => {
		if (request.url().includes("/api/agent/chat")) chats.push(request.url());
	});
	await page.goto("/admin");
	const dialog = await openWhy(page, page.getByTestId("attention-ai-errors"));
	await dialog.getByRole("button", { name: "Ask AI" }).click();
	await expect(page).toHaveURL(/\/inbox/);
	const input = page.getByRole("region", { name: "Email assistant" }).getByRole("textbox", { name: "Message Kite AI" });
	await expect(input).toHaveValue(/^Kite recorded \d+ failed AI requests in the last 24 hours\./);
	await expect(input).toHaveValue(new RegExp(`provider_auth: \\d+ times[\\s\\S]*OpenAI · ${model}`));
	await expect(input).toHaveValue(/cut_off: \d+ times?[\s\S]*Kite facts: Output cap: [\d,]+ tokens/);
	await expect(input).toHaveValue(/Kite's diagnosis: [^\n]*capped \S+'s answer at [\d,]+ tokens/);
	await expect(input).toHaveValue(/About Automatic reading: /);
	await expect(input).not.toHaveValue(new RegExp(`@${DOMAIN}`));
	await expect(input).toBeFocused();
	expect(chats).toEqual([]);
});

test("Why? and Ask AI in the command center open the assistant in place", async ({ page }) => {
	await mockAssistant(page);
	await withAssistant(page, { available: true });
	await page.goto("/inbox");
	const item = page.getByTestId("command-center-attention-ai-errors");
	await expect(item).toBeVisible();
	const dialog = await openWhy(page, item);
	await expect(dialog.locator('[data-ai-failure-group="provider_auth"]')).toBeVisible();
	await dialog.getByRole("button", { name: "Ask AI" }).click();
	await expect(dialog).toBeHidden();
	await expect(page).toHaveURL(/\/inbox/);
	const input = page.getByRole("region", { name: "Email assistant" }).getByRole("textbox", { name: "Message Kite AI" });
	await expect(input).toHaveValue(/^Kite recorded/);
	// The dialog closing in place leaves the focus in the assistant, not on Why?.
	await expect(input).toBeFocused();
});

test("Ask AI says why it can't run instead of offering a request that would fail", async ({ page }) => {
	await withAssistant(page, {
		available: false,
		reason: "Ask AI would fail the same way: the assistant uses OpenAI, which is failing (provider_auth).",
		link: { href: "/agent#ai-provider", label: "Open AI provider settings" },
	});
	await page.goto("/admin");
	const dialog = await openWhy(page, page.getByTestId("attention-ai-errors"));
	await expect(dialog.getByRole("button", { name: "Ask AI" })).toHaveCount(0);
	const unavailable = dialog.getByTestId("ai-failures-ask-unavailable");
	await expect(unavailable).toContainText("would fail the same way");
	await expect(unavailable.getByRole("link", { name: "Open AI provider settings" })).toHaveAttribute(
		"href",
		"/agent#ai-provider",
	);
	// Closing the dialog hands the focus back to Why?.
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	await expect(page.getByTestId("attention-ai-errors").getByRole("button", { name: "Why?" })).toBeFocused();
});

test("a question Ask AI prepared long ago is dropped instead of opening the assistant", async ({ page }) => {
	// Prepared ten minutes ago and never taken, as when the move to the mailbox failed.
	await page.addInitScript(() => {
		sessionStorage.setItem(
			"kite:assistant-prompt",
			JSON.stringify({ text: "Kite recorded 1 failed AI request", at: Date.now() - 10 * 60 * 1000 }),
		);
	});
	await page.goto("/inbox");
	await expect.poll(() => page.evaluate(() => sessionStorage.getItem("kite:assistant-prompt"))).toBeNull();
	await expect(
		page.getByRole("region", { name: "Email assistant" }).getByRole("textbox", { name: "Message Kite AI" }),
	).toBeHidden();
});

test("the report is the primary admin's: other admins and members get 403 and no Why?", async ({ browser }) => {
	const admin = await apiContext(STORAGE_STATE);
	const report = await okJson<{ total: number; groups: { code: string }[]; prompt: string }>(
		await admin.get("/api/admin/agent/errors/report"),
	);
	expect(report.groups.map((group) => group.code)).toContain("provider_auth");
	expect(report.prompt).not.toContain(`@${DOMAIN}`);
	const member = await createSignedInAccount(admin, uniqueToken("whym"));
	const otherAdmin = await createSignedInAccount(admin, uniqueToken("whya"), "admin");
	try {
		expect((await member.api.get("/api/admin/agent/errors/report")).status()).toBe(403);
		expect((await otherAdmin.api.get("/api/admin/agent/errors/report")).status()).toBe(403);
		const context = await browser.newContext({ storageState: await member.api.storageState() });
		const page = await context.newPage();
		await page.goto("/inbox");
		await expect(page.getByTestId("reading-pane-empty")).toBeVisible();
		await expect(page.getByTestId("command-center-attention")).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Why?" })).toHaveCount(0);
		await context.close();
	} finally {
		await member.api.dispose();
		await otherAdmin.api.dispose();
		await admin.dispose();
	}
});
