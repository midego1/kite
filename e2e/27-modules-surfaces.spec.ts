import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { BASE_URL } from "./support/constants";
import { CALENDAR_TOOLS, firstMailboxId, openPageCommands, sendChat, toolNames } from "./support/chat";
import { type FakeModel } from "./support/fake-model-types";
import { uniqueToken } from "./support/helpers";
import { createMcpKey, mcpToolNames } from "./support/mcp";
import { restoreModules, setModuleState, type ModuleId } from "./support/modules";
import { expectNotFoundPage, expectPaletteCommands, openAccountMenu } from "./support/module-flows";
import {
	CALENDAR_EVENTS,
	CALENDAR_MCP_TOOLS,
	CALENDAR_SCOPES,
	FINANCE_EVENTS,
	createEvent,
	createTemplate,
	deleteKeys,
	expectLink,
	fakeAssistant,
	lastChatRequest,
	openSendMenu,
	owner,
	ownerBooking,
	searchSections,
	templateStatusRows,
	visitor,
} from "./support/module-spec";

// Each module's surfaces go away and come back together.

/** The owner's clients, a fake model the assistant uses and an MCP key with calendar scopes. */
type SurfaceRig = {
	api: APIRequestContext;
	anonymous: APIRequestContext;
	fake: FakeModel;
	mailboxId: string;
	mcpKey: string;
	host: { id: string; username: string };
};

async function withSurfaceRig(run: (rig: SurfaceRig) => Promise<void>) {
	const api = await owner();
	const anonymous = await visitor();
	const { fake, cleanup } = await fakeAssistant(api);
	const keys: string[] = [];
	try {
		const mailboxId = await firstMailboxId(api);
		const key = await createMcpKey(api, "E2E module surfaces", ["mcp:read", ...CALENDAR_SCOPES], [mailboxId]);
		keys.push(key.id);
		await run({ api, anonymous, fake, mailboxId, mcpKey: key.key, host: await ownerBooking(api) });
	} finally {
		await restoreModules(api);
		await deleteKeys(api, { mcp: keys });
		await cleanup();
		await anonymous.dispose();
		await api.dispose();
	}
}

/** The tools and `open_page` commands the assistant offers the owner in a chat right now. */
async function assistantOffer(rig: SurfaceRig) {
	rig.fake.clearRequests();
	await sendChat(rig.api, rig.mailboxId, "What can you open for me?");
	const request = await lastChatRequest(rig.fake);
	return { tools: toolNames(request), pages: openPageCommands(request) ?? [] };
}

async function webhookCatalog(api: APIRequestContext): Promise<string[]> {
	const { eventCatalog } = (await (await api.get("/api/webhooks")).json()) as { eventCatalog: { value: string }[] };
	return eventCatalog.map((event) => event.value);
}

async function expectPageState(page: Page, path: string, on: boolean) {
	if (!on) return expectNotFoundPage(page, path);
	const response = await page.goto(path);
	expect(response?.status(), path).toBe(200);
	await expect(page.getByText("Page not found")).toHaveCount(0);
}

/** Turns one module off and on again, checking every surface it owns before, while off and after. */
async function offThenOn(api: APIRequestContext, moduleId: ModuleId, expectSurfaces: (on: boolean) => Promise<void>) {
	await expectSurfaces(true);
	await setModuleState(api, { modules: { [moduleId]: false } });
	await expectSurfaces(false);
	await setModuleState(api, { modules: { [moduleId]: true } });
	await expectSurfaces(true);
}

test("Calendar off then on removes and restores every calendar surface: nav, page, API, palette, assistant, MCP, webhooks and search", async ({
	page,
}) => {
	await withSurfaceRig(async (rig) => {
		const word = uniqueToken("surfaceword");
		const eventId = await createEvent(rig.api, `Surface ${word}`);
		try {
			await offThenOn(rig.api, "calendar", async (on) => {
				await expectLink(await openAccountMenu(page), "Calendar", on);
				await page.goto("/inbox");
				await expectPaletteCommands(page, "calendar", ["Open Calendar", "Go to a date in Calendar"], on);
				await expectPageState(page, "/calendar", on);
				if (on) await expect(page.getByRole("button", { name: "Today" })).toBeVisible();
				expect((await rig.api.get("/api/calendar/events")).status()).toBe(on ? 200 : 404);

				const offer = await assistantOffer(rig);
				expect(CALENDAR_TOOLS.filter((name) => offer.tools.includes(name))).toEqual(on ? CALENDAR_TOOLS : []);
				expect(offer.tools).toEqual(expect.arrayContaining(["list_emails", "search_emails", "open_page"]));
				expect(offer.pages.filter((id) => id.startsWith("calendar.")).sort()).toEqual(
					on ? ["calendar.go_to_date", "calendar.open"] : [],
				);
				const mcp = await mcpToolNames(rig.anonymous, rig.mcpKey);
				expect(CALENDAR_MCP_TOOLS.filter((name) => mcp.includes(name))).toEqual(on ? CALENDAR_MCP_TOOLS : []);
				expect(mcp).toContain("list_emails");
				const catalog = await webhookCatalog(rig.api);
				expect(CALENDAR_EVENTS.filter((event) => catalog.includes(event))).toEqual(on ? CALENDAR_EVENTS : []);
				expect((await searchSections(rig.api, word)).map((section) => section.id)).toEqual(on ? ["events"] : []);
			});
		} finally {
			await rig.api.delete(`/api/calendar/events/${eventId}`);
		}
	});
});

test("Booking off then on removes and restores every booking surface: tab, menu link, pages, public routes, API, palette, assistant and webhooks", async ({
	browser,
	page,
}) => {
	const guest = await browser.newContext({ baseURL: BASE_URL, storageState: undefined });
	try {
		await withSurfaceRig(async (rig) => {
			await offThenOn(rig.api, "booking", async (on) => {
				await page.goto("/calendar");
				const tabs = page.getByRole("navigation", { name: "Calendar sections" });
				await expect(tabs.getByRole("link")).toHaveText(on ? ["Bookings", "Calendar"] : ["Calendar"]);
				await expectLink(await openAccountMenu(page), "Booking", on);
				await page.goto("/inbox");
				await expectPaletteCommands(page, "booking", ["Open Booking", "Open a booking event type"], on);
				await expectPageState(page, "/booking", on);

				const publicPage = await guest.newPage();
				for (const path of [`/c/${rig.host.username}`, `/book/${rig.host.id}`])
					expect((await publicPage.goto(path))?.status(), path).toBe(on ? 200 : 404);
				await publicPage.close();
				expect((await rig.api.get("/api/booking")).status()).toBe(on ? 200 : 404);
				const publicApi = await rig.anonymous.get(`/api/public/booking?username=${rig.host.username}`);
				expect(publicApi.status()).toBe(on ? 200 : 404);

				const offer = await assistantOffer(rig);
				expect(offer.pages.filter((id) => id.startsWith("booking.")).sort()).toEqual(
					on ? ["booking.open", "booking.open_event_type"] : [],
				);
				expect(offer.pages).toContain("calendar.open");
				expect((await webhookCatalog(rig.api)).includes("booking.appointment.created")).toBe(on);
			});
		});
	} finally {
		await guest.close();
	}
});

test("Email templates off then on removes and restores the send-menu entry, the API and the template list", async ({
	page,
}) => {
	const api = await owner();
	let templateId = "";
	try {
		templateId = await createTemplate(api, `Surface template ${uniqueToken("tpl")}`, "Surface body");
		await offThenOn(api, "templates", async (on) => {
			const menu = await openSendMenu(page);
			if (on) await expect(menu.getByRole("menuitem", { name: "Template" })).toBeVisible();
			else {
				await expect(menu.getByRole("menuitem", { name: "Tomorrow morning" })).toBeVisible();
				await expect(menu.getByRole("menuitem", { name: "Template" })).toHaveCount(0);
			}
			await page.keyboard.press("Escape");
			expect((await api.get("/api/templates")).status()).toBe(on ? 200 : 404);
			expect((await templateStatusRows(api)).some((row) => row.id === templateId)).toBe(on);
		});
	} finally {
		await restoreModules(api);
		if (templateId) await api.delete(`/api/templates/${templateId}`);
		await api.dispose();
	}
});

test("Mail import off then on removes and restores the Settings item, page, API, palette command, assistant page and old link", async ({
	page,
}) => {
	await withSurfaceRig(async (rig) => {
		await offThenOn(rig.api, "import", async (on) => {
			await page.goto("/settings/account");
			const menu = page.getByRole("complementary", { name: "Settings menu" });
			await expectLink(menu, "Export", true);
			await expectLink(menu, "Import", on);
			await expectPageState(page, "/settings/import", on);
			expect((await rig.api.get("/api/import/jobs")).status()).toBe(on ? 200 : 404);
			await page.goto("/inbox");
			await expectPaletteCommands(page, "import", ["Import mail"], on);
			await page.goto("/settings/import-export");
			await expect(page).toHaveURL(on ? /\/settings\/import$/ : /\/settings\/export$/);
			const offer = await assistantOffer(rig);
			expect(offer.pages.includes("import.open")).toBe(on);
			expect(offer.pages).toContain("mail.export");
		});
	});
});

test("Money Watch off then on removes and restores every finance surface: nav, page, API, palette, assistant, MCP, webhooks and search", async ({
	page,
}) => {
	await withSurfaceRig(async (rig) => {
		const vendor = `Surfaceflix${uniqueToken("").slice(-4)}`;
		const key = await createMcpKey(rig.api, "E2E finance surfaces", ["mcp:read", "mcp:finance-read"], [rig.mailboxId]);
		let subscriptionId = "";
		try {
			const created = await rig.api.post("/api/finance/subscriptions", {
				data: { vendor, amountMinor: 999, currency: "USD", cycle: "monthly", reminderDays: 0, calendarReminder: false },
			});
			expect(created.status(), await created.text()).toBe(200);
			subscriptionId = ((await created.json()) as { subscription: { id: string } }).subscription.id;
			await offThenOn(rig.api, "finance", async (on) => {
				await page.goto("/inbox");
				const sidebar = page.getByRole("navigation").first();
				await expect(sidebar.locator('a[href="/inbox"]').last()).toBeVisible();
				if (on) await expect(sidebar.locator('a[href="/finance"]')).toBeVisible();
				else await expect(sidebar.locator('a[href="/finance"]')).toHaveCount(0);
				await expectPaletteCommands(page, "money", ["Open Subscriptions", "Add a subscription"], on);
				await expectPageState(page, "/finance", on);
				if (on) await expect(page.getByRole("heading", { level: 1, name: "Subscriptions" })).toBeVisible();
				expect((await rig.api.get("/api/finance/subscriptions")).status()).toBe(on ? 200 : 404);
				expect((await rig.anonymous.get("/api/finance/subscriptions")).status()).toBe(on ? 401 : 404);

				const offer = await assistantOffer(rig);
				expect(offer.tools.includes("list_subscriptions")).toBe(on);
				expect(offer.tools).toEqual(expect.arrayContaining(["list_emails", "search_emails", "open_page"]));
				expect(offer.pages.filter((id) => id.startsWith("finance.")).sort()).toEqual(
					on ? ["finance.add", "finance.open"] : [],
				);
				const mcp = await mcpToolNames(rig.anonymous, key.key);
				expect(mcp.includes("list_subscriptions")).toBe(on);
				expect(mcp).toContain("list_emails");
				const catalog = await webhookCatalog(rig.api);
				expect(FINANCE_EVENTS.filter((event) => catalog.includes(event))).toEqual(on ? FINANCE_EVENTS : []);
				expect((await searchSections(rig.api, vendor)).map((section) => section.id)).toEqual(
					on ? ["subscriptions"] : [],
				);
			});
		} finally {
			if (subscriptionId) await rig.api.delete(`/api/finance/subscriptions/${subscriptionId}`);
			await deleteKeys(rig.api, { mcp: [key.id] });
		}
	});
});
