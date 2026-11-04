import { expect, test, type Page } from "@playwright/test";
import { BASE_URL } from "./support/constants";
import { signIn, uniqueToken } from "./support/helpers";
import { restoreModules, setModuleState } from "./support/modules";
import {
	MEMBER_PASSWORD,
	createMember,
	createTemplate,
	expectEveryModuleOn,
	openSendMenu,
	owner,
	templateStatusRows,
} from "./support/module-spec";

/** What the page asks for while the composer's send menu is opened, collected until the returned function is read. */
function watchTemplateTraffic(page: Page): () => string[] {
	const seen: string[] = [];
	page.on("request", (request) => {
		const path = new URL(request.url()).pathname;
		if (path.includes("/api/templates") || path.includes("components/modules/templates/")) seen.push(path);
	});
	return () => seen;
}

async function expectScheduleOnlyMenu(page: Page, seen: () => string[]) {
	const menu = await openSendMenu(page);
	await expect(menu.getByRole("menuitem", { name: "Template" })).toHaveCount(0);
	await expect(menu.getByText("New template")).toHaveCount(0);
	await expect(menu.locator("> *").first()).toHaveText("Schedule");
	await expect(menu.getByRole("menuitem", { name: "Tomorrow morning" })).toBeVisible();
	await page.waitForTimeout(500);
	expect(seen()).toEqual([]);
	await page.keyboard.press("Escape");
}

test("with Templates off the send menu has only schedule options and no template request or code, and the template still applies when it is back", async ({
	page,
}) => {
	const api = await owner();
	const word = uniqueToken("tplword");
	let templateId = "";
	try {
		templateId = await createTemplate(api, `Template subject ${word}`, `Template body ${word}`);
		expect((await templateStatusRows(api)).map((row) => row.id)).toContain(templateId);
		for (const status of ["received", "sent", "draft", "spam", "trash", "archived"]) {
			const listed = (await (await api.get(`/api/messages?status=${status}`)).json()) as { messages: { id: string }[] };
			expect(
				listed.messages.map((row) => row.id),
				status,
			).not.toContain(templateId);
		}
		const everything = (await (await api.get(`/api/messages?q=${word}`)).json()) as { messages: unknown[] };
		expect(everything.messages).toEqual([]);

		await setModuleState(api, { modules: { templates: false } });
		const seen = watchTemplateTraffic(page);
		await expectScheduleOnlyMenu(page, seen);

		expect((await api.get("/api/templates")).status()).toBe(404);
		expect((await api.post("/api/templates", { data: { title: "x", text: "y" } })).status()).toBe(404);
		const deleted = await api.delete(`/api/templates/${templateId}`);
		expect(deleted.status()).toBe(404);
		expect(await deleted.json()).toEqual({ error: "Not found" });
		expect(await templateStatusRows(api)).toEqual([]);
		const offLists = (await (await api.get("/api/messages")).json()) as { messages: { id: string }[] };
		expect(offLists.messages.map((row) => row.id)).not.toContain(templateId);

		await setModuleState(api, { modules: { templates: true } });
		expect((await templateStatusRows(api)).map((row) => row.id)).toContain(templateId);
		const menu = await openSendMenu(page);
		await expect(menu.getByRole("menuitem", { name: "Template" })).toBeVisible();
		expect(seen()).toContain("/api/templates");
		// The submenu is opened and picked by keyboard: a teleporting pointer leaves Radix's grace area and closes it.
		await menu.getByRole("menuitem", { name: "Template" }).focus();
		await page.keyboard.press("ArrowRight");
		await expect(page.getByRole("menuitem", { name: "New template" })).toBeVisible();
		await page.getByRole("menuitem", { name: `Template subject ${word}` }).focus();
		await page.keyboard.press("Enter");
		await expect(page.getByLabel("Subject")).toHaveValue(`Template subject ${word}`);
		await expect(page.getByRole("textbox", { name: "Message body" })).toContainText(`Template body ${word}`);
	} finally {
		await restoreModules(api);
		if (templateId) await api.delete(`/api/templates/${templateId}`);
		await api.dispose();
	}
});

test("a user restricted from Templates loses the slot and the API while the owner keeps both", async ({
	browser,
	page,
}) => {
	const api = await owner();
	const member = await createMember(api);
	const context = await browser.newContext({ baseURL: BASE_URL, storageState: undefined });
	let templateId = "";
	try {
		const word = uniqueToken("tplmember");
		templateId = await createTemplate(api, `Member template ${word}`, `Body ${word}`);
		await setModuleState(api, { access: [{ userId: member.id, moduleId: "templates", allowed: false }] });

		const memberPage = await context.newPage();
		await signIn(memberPage, member.email, MEMBER_PASSWORD);
		await expect(memberPage).toHaveURL(/\/inbox/);
		const seen = watchTemplateTraffic(memberPage);
		await expectScheduleOnlyMenu(memberPage, seen);
		expect((await member.api.get("/api/templates")).status()).toBe(404);
		expect(await templateStatusRows(member.api)).toEqual([]);

		expect((await api.get("/api/templates")).status()).toBe(200);
		expect((await templateStatusRows(api)).map((row) => row.id)).toContain(templateId);
		const menu = await openSendMenu(page);
		await expect(menu.getByRole("menuitem", { name: "Template" })).toBeVisible();
	} finally {
		await restoreModules(api, [member.id]);
		if (templateId) await api.delete(`/api/templates/${templateId}`);
		await context.close();
		await member.api.dispose();
		await api.dispose();
	}
});

test("with Templates on the composer loads no template code or data until the send menu is first opened", async ({
	page,
}) => {
	const api = await owner();
	let templateId = "";
	try {
		const word = uniqueToken("lazyword");
		templateId = await createTemplate(api, `Lazy subject ${word}`, `Lazy body ${word}`);
		const seen = watchTemplateTraffic(page);
		await page.goto("/inbox");
		await page.getByRole("button", { name: "Compose" }).click();
		const trigger = page.getByRole("button", { name: "Schedule send options" });
		await expect(trigger).toBeVisible();
		await page.waitForTimeout(800);
		expect(seen()).toEqual([]);

		await trigger.click();
		const menu = page.getByRole("menu");
		await expect(menu.getByRole("menuitem", { name: "Template" })).toBeVisible();
		await expect.poll(() => seen().some((path) => path.includes("components/modules/templates/"))).toBe(true);
		expect(seen()).toContain("/api/templates");
		await page.keyboard.press("Escape");
	} finally {
		if (templateId) await api.delete(`/api/templates/${templateId}`);
		await api.dispose();
	}
});

test("the New template dialog works after the send menu has closed, and an earlier template still applies", async ({
	page,
}) => {
	const api = await owner();
	const created: string[] = [];
	try {
		const word = uniqueToken("dlgword");
		created.push(await createTemplate(api, `Earlier subject ${word}`, `Earlier body ${word}`));
		const menu = await openSendMenu(page);
		await menu.getByRole("menuitem", { name: "Template" }).focus();
		await page.keyboard.press("ArrowRight");
		await page.getByRole("menuitem", { name: "New template" }).focus();
		await page.keyboard.press("Enter");
		await expect(page.getByRole("menu")).toHaveCount(0);
		const dialog = page.getByRole("dialog", { name: "New template" });
		await expect(dialog).toBeVisible();
		await dialog.getByLabel("Title").fill(`Fresh ${word}`);
		await dialog.getByLabel("Content").fill(`Fresh body ${word}`);
		await dialog.getByRole("button", { name: "Save template" }).click();
		await expect(dialog).toHaveCount(0);
		const saved = (await templateStatusRows(api)).map((row) => row.id);
		created.push(...saved.filter((id) => !created.includes(id)));
		expect(saved.length).toBeGreaterThanOrEqual(2);

		await page.getByRole("button", { name: "Schedule send options" }).click();
		await page.getByRole("menuitem", { name: "Template" }).focus();
		await page.keyboard.press("ArrowRight");
		await expect(page.getByRole("menuitem", { name: `Fresh ${word}` })).toBeVisible();
		await page.getByRole("menuitem", { name: `Earlier subject ${word}` }).focus();
		await page.keyboard.press("Enter");
		await expect(page.getByLabel("Subject")).toHaveValue(`Earlier subject ${word}`);
		await expect(page.getByRole("textbox", { name: "Message body" })).toContainText(`Earlier body ${word}`);
	} finally {
		for (const id of created) await api.delete(`/api/templates/${id}`);
		await api.dispose();
	}
});

// Fails this file when one of its tests left a module off or a user restricted.
test.afterAll(async () => {
	await expectEveryModuleOn();
});
