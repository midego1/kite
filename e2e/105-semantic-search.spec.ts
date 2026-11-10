import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, postInbound, uniqueToken, waitForMessage } from "./support/helpers";

/**
 * "Search by meaning" (docs/specs/semantic-search.md): the hybrid list, its "By meaning" chip, the meaning-only
 * badge, conversation view, and the install switch hiding the chip entirely. A live embedding call needs Workers AI
 * (`env.AI`, always bound on this runtime: per the spec's decision 15 table, Workers always uses it and the admin's
 * own "compatible" choice only applies on the Node runtime) or real Cloudflare credentials this sandbox does not
 * have, so these mock the hybrid fields of a `GET /api/messages` response onto really-delivered messages instead of
 * running a live embedding pipeline; that pipeline (trigger, drain, vector store, D1 re-check, the query timeout,
 * the No-AI/excluded-mailbox defence in depth) is covered end to end by tests/semantic-scope.test.mjs and
 * tests/semantic-drain.test.mjs.
 */

let api: APIRequestContext;

test.beforeAll(async () => {
	api = await apiContext(STORAGE_STATE);
});

test.afterAll(async () => {
	await api.dispose();
});

/**
 * The By meaning chip only renders while the install has something to do (`semanticSearchAvailable` on
 * `GET /api/mailboxes`), so a test whose list response is mocked still needs the real install switch on for the
 * chip itself to show; restores whatever it was before once `fn` is done.
 */
async function withSemanticSearchEnabled(fn: () => Promise<void>): Promise<void> {
	const status = await (await api.get("/api/admin/semantic-search")).json();
	const wasEnabled = !!status.settings?.enabled;
	const enabled = await api.put("/api/admin/semantic-search", { data: { enabled: true } });
	expect(enabled.ok(), await enabled.text()).toBe(true);
	try {
		await fn();
	} finally {
		const restored = await api.put("/api/admin/semantic-search", { data: { enabled: wasEnabled } });
		expect(restored.ok(), await restored.text()).toBe(true);
	}
}

async function openSearch(
	page: Page,
	options: { conversationView?: boolean } = {},
): Promise<{
	panel: Locator;
	search: Locator;
}> {
	await page.addInitScript(
		(on) => localStorage.setItem("kite-conversation-view", on ? "on" : "off"),
		options.conversationView ?? false,
	);
	await page.goto("/inbox");
	const panel = page.getByTestId("mail-search-panel");
	const search = panel.getByRole("textbox", { name: /Search mail/ });
	return { panel, search };
}

test("a meaning-only match is labelled, and turning the By meaning chip off drops it", async ({ page }) => {
	const token = uniqueToken("meaning");
	const englishSubject = `Dentist appointment ${token}`;
	const dutchSubject = `Afspraak bij de tandarts ${token}`;
	await postInbound(api, {
		from: "clinic@acme.example",
		to: SUPPORT_ADDRESS,
		subject: englishSubject,
		text: "Your dentist appointment is confirmed for next Tuesday morning.",
	});
	await postInbound(api, {
		from: "clinic@acme.example",
		to: SUPPORT_ADDRESS,
		subject: dutchSubject,
		text: "Uw afspraak bij de tandarts is bevestigd voor dinsdagochtend.",
	});
	const english = await waitForMessage(api, englishSubject);
	// The Dutch row's own subject is literal keyword text for this lookup, so it is real stored data,
	// just not discoverable through the "dentist" query without a live embedding call.
	const dutch = await waitForMessage(api, dutchSubject);

	await page.route("**/api/messages?**", async (route) => {
		const url = new URL(route.request().url());
		if (url.searchParams.get("q") !== "dentist" || url.searchParams.get("semantic") === "0") {
			await route.continue();
			return;
		}
		const response = await route.fetch();
		const body = (await response.json()) as { messages: Record<string, unknown>[]; total: number };
		const withoutDutch = body.messages.filter((message) => message.id !== dutch.id);
		const englishRow = withoutDutch.find((message) => message.id === english.id);
		if (englishRow) englishRow.match = "both";
		await route.fulfill({
			response,
			json: {
				...body,
				messages: [...withoutDutch, { ...dutch, match: "meaning" }],
				total: withoutDutch.length + 1,
				semantic: "on",
			},
		});
	});

	await withSemanticSearchEnabled(async () => {
		const { panel, search } = await openSearch(page);
		await search.fill("dentist");
		await search.press("Enter");

		const main = page.getByRole("main");
		await expect(main.getByText(englishSubject, { exact: true })).toBeVisible();
		await expect(main.getByText(dutchSubject, { exact: true })).toBeVisible();

		// Only the Dutch row was found through meaning alone; the English row (labelled "both") keeps its ordinary badges.
		const dutchRow = main.locator("[data-message-row]", { hasText: dutchSubject });
		await expect(dutchRow.getByTitle("Found by meaning, not exact words")).toBeVisible();
		const englishRow = main.locator("[data-message-row]", { hasText: englishSubject });
		await expect(englishRow.getByTitle("Found by meaning, not exact words")).toHaveCount(0);

		// Turning the "By meaning" chip off asks the server for keyword matches only (semantic=0): the mocked
		// route passes that request straight through, so the Dutch row (no shared word with "dentist") drops out.
		await panel.getByRole("button", { name: "By meaning" }).click();
		await expect(main.getByText(englishSubject, { exact: true })).toBeVisible();
		await expect(main.getByText(dutchSubject, { exact: true })).toHaveCount(0);
	});
});

test("when search by meaning is off for the install, the By meaning chip is hidden and no note is shown", async ({
	page,
}) => {
	const token = uniqueToken("meaningoff");
	const subject = `Tandarts herinnering ${token}`;
	await postInbound(api, {
		from: "clinic@acme.example",
		to: SUPPORT_ADDRESS,
		subject,
		text: "Dit is een herinnering voor uw tandarts afspraak.",
	});
	await waitForMessage(api, subject);

	const status = await (await api.get("/api/admin/semantic-search")).json();
	const wasEnabled = !!status.settings?.enabled;
	const off = await api.put("/api/admin/semantic-search", { data: { enabled: false } });
	expect(off.ok(), await off.text()).toBe(true);
	try {
		const { panel, search } = await openSearch(page);
		await search.fill(subject);
		await search.press("Enter");

		const main = page.getByRole("main");
		await expect(main.getByText(subject, { exact: true })).toBeVisible();
		// "off" is not a runtime failure: it is quiet (C1), and the chip itself has nothing to do, so it does not
		// render at all (GET /api/mailboxes's semanticSearchAvailable), rather than showing disabled.
		await expect(panel.getByRole("button", { name: "By meaning" })).toHaveCount(0);
		await expect(
			page.getByText("Showing keyword matches only — search by meaning is unavailable right now."),
		).toHaveCount(0);
	} finally {
		const restored = await api.put("/api/admin/semantic-search", { data: { enabled: wasEnabled } });
		expect(restored.ok(), await restored.text()).toBe(true);
	}
});

test("a meaning-only match is still found in conversation view, grouped under its own thread", async ({ page }) => {
	const token = uniqueToken("grouped");
	const dutchSubject = `Afspraak bij de tandarts ${token}`;
	await postInbound(api, {
		from: "clinic@acme.example",
		to: SUPPORT_ADDRESS,
		subject: dutchSubject,
		text: "Uw afspraak bij de tandarts is bevestigd voor dinsdagochtend.",
	});
	const dutch = await waitForMessage(api, dutchSubject);

	await page.route("**/api/messages?**", async (route) => {
		const url = new URL(route.request().url());
		if (url.searchParams.get("q") !== "dentist" || url.searchParams.get("group") !== "thread") {
			await route.continue();
			return;
		}
		const response = await route.fetch();
		const body = (await response.json()) as { messages: Record<string, unknown>[]; total: number };
		await route.fulfill({
			response,
			json: {
				...body,
				messages: [...body.messages, { ...dutch, match: "meaning" }],
				total: body.messages.length + 1,
				semantic: "on",
			},
		});
	});

	// Conversation view is the default; openSearch only needs to not turn it off here.
	const { search } = await openSearch(page, { conversationView: true });
	await search.fill("dentist");
	await search.press("Enter");

	const main = page.getByRole("main");
	await expect(main.getByText(dutchSubject, { exact: true })).toBeVisible();
	const dutchRow = main.locator("[data-message-row]", { hasText: dutchSubject });
	await expect(dutchRow.getByTitle("Found by meaning, not exact words")).toBeVisible();
});
