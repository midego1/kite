import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { ADMIN, BASE_URL, SUPPORT_ADDRESS } from "./support/constants";
import { CALENDAR_TOOLS, askAssistant, openAssistantPanel, toolNames } from "./support/chat";
import {
	deliverInbound,
	openMessage,
	readBackups,
	setSendingSettings,
	signIn,
	uniqueToken,
	waitForBackup,
	waitForMessage,
	waitForRestore,
} from "./support/helpers";
import { restoreModules, setModuleState } from "./support/modules";
import { bookAppointment, expectPaletteCommands, openAccountMenu, watchCoreTraffic } from "./support/module-flows";
import {
	createEvent,
	createTemplate,
	expectLink,
	fakeAssistant,
	lastChatRequest,
	moduleSwitch,
	openSendMenu,
	owner,
	templateStatusRows,
	visitor,
} from "./support/module-spec";

// An open tab follows a toggle, and an install with every module off keeps the core working, including its backups.

const ALL_MODULES_OFF = {
	calendar: false,
	booking: false,
	templates: false,
	import: false,
	finance: false,
	drive: false,
};

test("an open calendar tab gets 404 from its calendar calls once Calendar is turned off in another tab, and not-found on reload", async ({
	context,
	page,
}) => {
	const api = await owner();
	const shot = (name: string, target: Page = page) =>
		target.screenshot({ path: test.info().outputPath(`${name}.png`) });
	try {
		await page.goto("/calendar");
		await expect(page.getByRole("button", { name: "Today" })).toBeVisible();
		await shot("calendar-before");

		const modules = await context.newPage();
		await modules.goto("/modules");
		await moduleSwitch(modules, "Calendar").click();
		await modules.getByRole("alertdialog").getByRole("button", { name: "Turn off Calendar" }).click();
		await expect(moduleSwitch(modules, "Calendar")).toHaveAttribute("aria-checked", "false");
		await shot("modules-calendar-off", modules);

		const calls: string[] = [];
		page.on("response", (response) => {
			const { pathname } = new URL(response.url());
			if (pathname.startsWith("/api/calendar")) calls.push(`${response.status()} ${pathname}`);
		});
		await page.bringToFront();
		const refetch = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/calendar/events");
		await page.getByRole("button", { name: /^Next (day|week|month)$/ }).click();
		expect((await refetch).status()).toBe(404);
		await shot("calendar-after-toggle");

		const reloaded = await page.reload();
		expect(reloaded?.status()).toBe(404);
		await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
		await shot("calendar-after-reload");
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.filter((call) => !call.startsWith("404 "))).toEqual([]);
	} finally {
		await restoreModules(api);
		await api.dispose();
	}
});

test("with migration 0062 applied the owner sees every module surface as before and reaches Modules from the inbox through the admin navigation", async ({
	page,
}) => {
	const api = await owner();
	const shot = (name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`) });
	try {
		const { modules } = (await (await api.get("/api/admin/modules")).json()) as {
			modules: { id: string; enabled: boolean; restrictedUsers: unknown[] }[];
		};
		expect(modules.map((item) => [item.id, item.enabled])).toEqual([
			["calendar", true],
			["booking", true],
			["templates", true],
			["import", true],
			["finance", true],
			["drive", true],
		]);

		const account = await openAccountMenu(page);
		await expectLink(account, "Calendar", true);
		await expectLink(account, "Booking", true);
		await shot("account-menu");
		await page.goto("/calendar");
		await expect(page.getByRole("navigation", { name: "Calendar sections" }).getByRole("link")).toHaveText([
			"Bookings",
			"Calendar",
		]);
		await shot("calendar-tabs");
		const send = await openSendMenu(page);
		await expect(send.getByRole("menuitem", { name: "Template" })).toBeVisible();
		await shot("send-menu");
		await page.keyboard.press("Escape");
		await page.goto("/settings/account");
		const settings = page.getByRole("complementary", { name: "Settings menu" });
		await expectLink(settings, "Import", true);
		await expectLink(settings, "Export", true);
		await shot("settings-menu");
		await page.goto("/inbox");
		await expectPaletteCommands(page, "calendar", ["Open Calendar", "Go to a date in Calendar"], true);
		await expectPaletteCommands(page, "booking", ["Open Booking", "Open a booking event type"], true);
		await expectPaletteCommands(page, "import", ["Import mail"], true);

		// From the inbox to Modules by clicking only: account menu, Admin, then Modules in the Admin menu.
		await page.goto("/inbox");
		await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
		await page.getByRole("button", { name: "Open account menu" }).click();
		await shot("click-1-account-menu");
		await page.locator('[data-placement="sidebar"]').getByRole("link", { name: "Admin", exact: true }).click();
		await expect(page).toHaveURL(/\/admin$/);
		await shot("click-2-admin");
		await page.getByRole("complementary", { name: "Admin menu" }).getByRole("link", { name: "Modules" }).click();
		await expect(page).toHaveURL(/\/modules$/);
		await expect(page.getByRole("heading", { level: 1, name: "Modules" })).toBeVisible();
		await expect(page.locator("[data-module]").getByRole("switch", { checked: true })).toHaveCount(6);
		await shot("click-3-modules");
	} finally {
		await api.dispose();
	}
});

/** Plain RGB colours of the Modules page, read through a canvas because computed colours may use any colour space. */
async function modulesPageColors(page: Page) {
	return page.evaluate(() => {
		const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
		const rgb = (css: string) => {
			context.clearRect(0, 0, 1, 1);
			context.fillStyle = css;
			context.fillRect(0, 0, 1, 1);
			return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
		};
		const card = document.querySelector('[data-module="calendar"]') as HTMLElement;
		const note = document.querySelector('[data-module="import"] p.rounded-xl') as HTMLElement;
		return {
			card: rgb(getComputedStyle(card).backgroundColor),
			title: rgb(getComputedStyle(card.querySelector("h2")!).color),
			description: rgb(getComputedStyle(card.querySelector("h2 + p")!).color),
			toggle: rgb(getComputedStyle(card.querySelector('[role="switch"]')!).backgroundColor),
			note: rgb(getComputedStyle(note).backgroundColor),
			noteText: rgb(getComputedStyle(note).color),
		};
	});
}

const luminanceOf = ([r, g, b]: number[]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

const contrastOf = (one: number[], two: number[]) => Math.abs(luminanceOf(one) - luminanceOf(two));

test("the Modules page and the Calendar confirmation read clearly in Kite, Classic and dark mode", async ({ page }) => {
	const api = await owner();
	try {
		const seen: Record<string, Awaited<ReturnType<typeof modulesPageColors>>> = {};
		for (const [style, theme] of [
			["kite", "light"],
			["classic", "light"],
			["kite", "dark"],
		] as const) {
			await page.addInitScript(
				([nextStyle, nextTheme]) => {
					localStorage.setItem("kite-style", nextStyle);
					localStorage.setItem("kite-theme", nextTheme);
				},
				[style, theme],
			);
			await page.goto("/modules");
			await expect(page.locator("html")).toHaveAttribute("data-style", style);
			await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${theme}\\b`));
			await expect(page.locator("[data-module] h2")).toHaveText([
				"Calendar",
				"Booking",
				"Email templates",
				"Mail import",
				"Money Watch",
				"Drive",
			]);
			const colors = await modulesPageColors(page);
			seen[`${style}-${theme}`] = colors;
			expect(contrastOf(colors.card, colors.title), `${style} ${theme} title`).toBeGreaterThan(0.4);
			expect(contrastOf(colors.card, colors.description), `${style} ${theme} description`).toBeGreaterThan(0.2);
			expect(contrastOf(colors.note, colors.noteText), `${style} ${theme} note`).toBeGreaterThan(0.4);
			await page.screenshot({ path: test.info().outputPath(`modules-${style}-${theme}.png`), fullPage: true });

			await moduleSwitch(page, "Calendar").click();
			const dialog = page.getByRole("alertdialog");
			await expect(dialog).toContainText("Booking will be turned off too");
			await page.screenshot({ path: test.info().outputPath(`modules-confirm-${style}-${theme}.png`) });
			await dialog.getByRole("button", { name: "Cancel" }).click();
			await expect(dialog).toHaveCount(0);
			await expect(moduleSwitch(page, "Calendar")).toHaveAttribute("aria-checked", "true");
		}
		expect(seen["kite-light"].toggle, "Kite accent differs from Classic blue").not.toEqual(
			seen["classic-light"].toggle,
		);
		expect(luminanceOf(seen["kite-dark"].card)).toBeLessThan(0.35);
	} finally {
		await restoreModules(api);
		await api.dispose();
	}
});

test("a mail-only install (every module off) keeps the inbox, reader, composer, search, settings, export and assistant working", async ({
	page,
}) => {
	test.setTimeout(180_000);
	const api = await owner();
	const { fake, cleanup } = await fakeAssistant(api);
	try {
		await setSendingSettings(api, { previewEnabled: false, undoSeconds: 0 });
		await setModuleState(api, { modules: ALL_MODULES_OFF });
		expect((await (await api.get("/api/auth/me")).json()).modules).toEqual([]);
		const word = uniqueToken("mailonly");
		const subject = `Mail only ${word}`;
		await deliverInbound(api, {
			from: `"Mail Only" <mail.only@outside.test>`,
			to: SUPPORT_ADDRESS,
			subject,
			text: `Plain body ${word}`,
			html: `<p>Reader body ${word}</p>`,
		});
		const traffic = watchCoreTraffic(page);
		await page.addInitScript(() => localStorage.setItem("kite-assistant-layout", "floating"));

		await page.goto("/inbox");
		await openMessage(page, subject);
		await expect(page.frameLocator('iframe[title="Message body"]').getByText(`Reader body ${word}`)).toBeVisible();

		const search = page.getByRole("textbox", { name: /Search mail/ });
		await search.fill("Cannot access workspace");
		await search.press("Enter");
		await expect(page.getByRole("main").getByText("Cannot access workspace", { exact: true }).first()).toBeVisible();
		await search.fill(word);
		await search.press("Enter");
		await expect(page.getByRole("main").getByText(subject, { exact: true }).first()).toBeVisible();

		await page.goto("/inbox");
		await page.getByRole("button", { name: "Compose" }).click();
		const to = page.getByLabel("To", { exact: true });
		await to.fill("receiver@e2e.test");
		await to.press("Enter");
		const draftSubject = `Mail only draft ${word}`;
		await page.getByLabel("Subject").fill(draftSubject);
		await page.getByRole("textbox", { name: "Message body" }).fill("Written with every module off");
		await expect(page.getByText("Draft saved")).toBeVisible();
		await waitForMessage(api, draftSubject, { status: "draft" });
		const sent = page.waitForResponse(
			(response) => response.url().endsWith("/api/send") && response.request().method() === "POST",
		);
		await page.getByRole("button", { name: "Send", exact: true }).click();
		expect((await sent).ok()).toBe(true);
		await expect(page.getByText("Message sent")).toBeVisible();
		await waitForMessage(api, draftSubject, { status: "sent" });

		await page.goto("/settings/account");
		const settings = page.getByRole("complementary", { name: "Settings menu" });
		await expect(settings.getByRole("link", { name: "Export" })).toBeVisible();
		const pages = await settings
			.getByRole("navigation")
			.getByRole("link")
			.evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
		expect(pages).toContain("/settings/export");
		expect(pages).not.toContain("/settings/import");
		for (const path of pages) {
			const response = await page.goto(path);
			expect(response?.status(), path).toBe(200);
			await expect(page.getByText("Page not found"), path).toHaveCount(0);
		}
		await page.goto("/settings/export");
		await expect(page.getByRole("button", { name: "Download .mbox" })).toBeVisible();
		const { mailboxes } = (await (await api.get("/api/mailboxes")).json()) as {
			mailboxes: { id: string; localPart: string }[];
		};
		const support = mailboxes.find((item) => item.localPart === "support")!;
		const mbox = await api.get(`/api/export/messages?mailboxId=${support.id}`);
		expect(mbox.status()).toBe(200);
		expect(mbox.headers()["content-type"]).toContain("application/mbox");
		expect(await mbox.text()).toContain(`Subject: ${subject}`);

		fake.clearRequests();
		fake.scriptChat({ content: `Mail-only answer ${word}` });
		const panel = await openAssistantPanel(page);
		await askAssistant(page, "Summarise my inbox");
		await expect(panel.getByText(`Mail-only answer ${word}`)).toBeVisible();
		const request = await lastChatRequest(fake);
		expect(toolNames(request)).toEqual(expect.arrayContaining(["list_emails", "search_emails", "open_page"]));
		expect(CALENDAR_TOOLS.filter((name) => toolNames(request).includes(name))).toEqual([]);

		expect(traffic.serverErrors).toEqual([]);
		expect(traffic.moduleRequests).toEqual([]);
		// A sender with no stored picture answers 404 and the reader shows initials, whatever the modules.
		expect(traffic.consoleErrors.filter((error) => !error.includes("/api/contacts/avatar?"))).toEqual([]);
	} finally {
		await restoreModules(api);
		await cleanup();
		await api.dispose();
	}
});

type BackupDocument = { includedTables: string[]; tables: Record<string, Record<string, unknown>[]> };

/** Row counts of the module data a backup document carries. */
function moduleDataCounts(document: BackupDocument) {
	return {
		calendar_events: document.tables.calendar_events.length,
		booking_events: document.tables.booking_events.length,
		booking_appointments: document.tables.booking_appointments.length,
		templates: document.tables.messages.filter((row) => row.status === "template").length,
	};
}

test("a mail-only install backs up and restores with its module data and with every module still off", async ({
	browser,
	page,
}) => {
	test.setTimeout(240_000);
	const api = await owner();
	const anonymous = await visitor();
	const made = { event: "", template: "", booking: "" };
	const context = await browser.newContext({ baseURL: BASE_URL, storageState: undefined });
	try {
		made.event = await createEvent(api, `Backup ${uniqueToken("bakevent")}`);
		made.template = await createTemplate(api, `Backup template ${uniqueToken("baktpl")}`, "Kept in the backup");
		made.booking = await bookAppointment(api, anonymous);
		await setModuleState(api, { modules: ALL_MODULES_OFF });

		await page.goto("/backups");
		await expect(page.getByRole("heading", { name: "Backups", level: 1 })).toBeVisible();
		// Earlier specs left backups behind; wait for the page to list them all before adding one.
		const before = (await readBackups(api)).length;
		await expect(page.getByTitle("Download backup")).toHaveCount(before);
		await page.getByRole("button", { name: "Back up" }).click();
		await expect(page.getByTitle("Download backup")).toHaveCount(before + 1);
		const newest = page.getByTitle("Download backup").first();
		await expect(newest).toBeEnabled({ timeout: 60_000 });
		await expect(page.getByRole("main").getByText("completed", { exact: true }).first()).toBeVisible();
		const downloading = page.waitForEvent("download");
		await newest.click();
		const backupFile = test.info().outputPath("mail-only-backup.json");
		await (await downloading).saveAs(backupFile);
		const document = JSON.parse(readFileSync(backupFile, "utf8")) as BackupDocument;
		for (const table of ["calendar_events", "booking_events", "booking_appointments", "messages", "module_settings"])
			expect(document.includedTables, table).toContain(table);
		expect(document.tables.module_settings.map((row) => [row.module_id, row.enabled]).sort()).toEqual([
			["booking", 0],
			["calendar", 0],
			["drive", 0],
			["finance", 0],
			["import", 0],
			["templates", 0],
		]);
		const counts = moduleDataCounts(document);
		expect(counts.calendar_events).toBeGreaterThan(0);
		expect(counts.booking_events).toBeGreaterThan(0);
		expect(counts.booking_appointments).toBeGreaterThan(0);
		expect(counts.templates).toBeGreaterThan(0);

		// A fresh session, because a restore signs out every session the backup does not hold.
		const restorer = await context.newPage();
		await signIn(restorer, ADMIN.email, ADMIN.password);
		await expect(restorer).toHaveURL(/\/inbox/);
		await restorer.goto("/backups");
		await expect(restorer.getByRole("heading", { name: "Backups", level: 1 })).toBeVisible();
		await restorer.getByRole("button", { name: "Backup actions" }).click();
		const chooser = restorer.waitForEvent("filechooser");
		await restorer.getByRole("menuitem", { name: "Restore from backup" }).click();
		await (await chooser).setFiles(backupFile);
		const confirm = restorer.getByRole("alertdialog", { name: "Restore this backup?" });
		await confirm.getByRole("button", { name: "Restore" }).click();
		await expect(restorer).toHaveURL(/\/login/, { timeout: 60_000 });
		const restore = await waitForRestore(api);
		expect(restore.status, restore.error ?? "").toBe("completed");
		await signIn(restorer, ADMIN.email, ADMIN.password);
		await expect(restorer).toHaveURL(/\/inbox/);
		await restorer.goto("/modules");
		await expect(restorer.locator("[data-module]").getByRole("switch", { checked: false })).toHaveCount(6);
		const stored = (await (await api.get("/api/admin/modules")).json()) as {
			modules: { id: string; enabled: boolean }[];
		};
		expect(stored.modules.map((item) => [item.id, item.enabled])).toEqual([
			["calendar", false],
			["booking", false],
			["templates", false],
			["import", false],
			["finance", false],
			["drive", false],
		]);
		expect((await api.get("/api/calendar/events")).status()).toBe(404);

		await restoreModules(api);
		const { backupId } = (await (await api.post("/api/backups")).json()) as { backupId: string };
		expect((await waitForBackup(api, backupId)).status).toBe("completed");
		const after = JSON.parse(await (await api.get(`/api/backups/${backupId}/download`)).text()) as BackupDocument;
		expect(moduleDataCounts(after)).toEqual(counts);
		expect((await templateStatusRows(api)).some((row) => row.id === made.template)).toBe(true);
		const events = (await (
			await api.get("/api/calendar/events?start=2031-05-01T00:00:00Z&end=2031-05-31T00:00:00Z")
		).json()) as {
			events: { id: string }[];
		};
		expect(events.events.some((event) => event.id === made.event)).toBe(true);
	} finally {
		await restoreModules(api);
		if (made.event) await api.delete(`/api/calendar/events/${made.event}`);
		if (made.template) await api.delete(`/api/templates/${made.template}`);
		if (made.booking) await api.delete(`/api/booking/${made.booking}`);
		await context.close();
		await anonymous.dispose();
		await api.dispose();
	}
});

test("after the spec every module is on and no user is restricted", async () => {
	const api = await owner();
	try {
		const { modules } = (await (await api.get("/api/admin/modules")).json()) as {
			modules: { id: string; enabled: boolean; restrictedUsers: unknown[] }[];
		};
		expect(modules.map((item) => [item.id, item.enabled, item.restrictedUsers.length])).toEqual([
			["calendar", true, 0],
			["booking", true, 0],
			["templates", true, 0],
			["import", true, 0],
			["finance", true, 0],
			["drive", true, 0],
		]);
		expect((await (await api.get("/api/auth/me")).json()).modules).toEqual([
			"calendar",
			"booking",
			"templates",
			"import",
			"finance",
			"drive",
		]);
	} finally {
		await api.dispose();
	}
});
