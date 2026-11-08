import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, postInbound, uniqueToken, waitForMessage } from "./support/helpers";

/**
 * "Search by meaning" (docs/specs/semantic-search.md): the hybrid list, its "By meaning" chip, the meaning-only
 * badge and the unavailable fallback note. A live embedding call needs Workers AI (`env.AI`, always bound on this
 * runtime: per the spec's decision 15 table, Workers always uses it and the admin's own "compatible" choice only
 * applies on the Node runtime) or real Cloudflare credentials this sandbox does not have, so the first test mocks
 * the hybrid fields of one `GET /api/messages` response onto two really-delivered messages instead of running a
 * live embedding pipeline; that pipeline (trigger, drain, vector store, D1 re-check) is covered end to end by
 * tests/semantic-scope.test.mjs and tests/semantic-drain.test.mjs. The second test needs no embedding at all:
 * turning the feature off is "unavailable" before any provider is resolved.
 */

let api: APIRequestContext;

test.beforeAll(async () => {
	api = await apiContext(STORAGE_STATE);
});

test.afterAll(async () => {
	await api.dispose();
});

async function openSearch(page: Page): Promise<{ panel: Locator; search: Locator }> {
	// Hybrid search only merges meaning hits into the non-conversation-grouped list view.
	await page.addInitScript(() => localStorage.setItem("kite-conversation-view", "off"));
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

test("when search by meaning is off for the install, the list falls back to keyword matches and says so", async ({
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
		const { search } = await openSearch(page);
		await search.fill(subject);
		await search.press("Enter");

		const main = page.getByRole("main");
		await expect(main.getByText(subject, { exact: true })).toBeVisible();
		await expect(
			page.getByText("Showing keyword matches only — search by meaning is unavailable right now."),
		).toBeVisible();
	} finally {
		const restored = await api.put("/api/admin/semantic-search", { data: { enabled: wasEnabled } });
		expect(restored.ok(), await restored.text()).toBe(true);
	}
});
