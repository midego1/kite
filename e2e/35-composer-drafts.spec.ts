import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, setSendingSettings, uniqueToken, waitForMessage } from "./support/helpers";

const RECIPIENT = "receiver@e2e.test";
const PAST_SCHEDULE_MESSAGE = "That send time has already passed. Pick a later time.";

type Draft = { id: string; subject: string | null; textBody: string | null };

async function draftsWithSubject(api: APIRequestContext, subject: string): Promise<Draft[]> {
	const response = await api.get("/api/drafts");
	expect(response.ok()).toBe(true);
	const { drafts } = (await response.json()) as { drafts: Draft[] };
	return drafts.filter((draft) => draft.subject === subject);
}

async function deleteDrafts(api: APIRequestContext, subject: string) {
	for (const draft of await draftsWithSubject(api, subject)) await api.delete(`/api/drafts/${draft.id}`);
}

function composerForm(page: Page) {
	return page.locator("form").filter({ has: page.getByRole("button", { name: "Close composer" }) });
}

async function openComposer(page: Page, { to }: { to?: string } = {}) {
	await page.getByRole("button", { name: "Compose" }).click();
	await expect(page.getByLabel("Subject")).toBeEditable();
	if (to) {
		const field = page.getByLabel("To", { exact: true });
		await field.fill(to);
		await field.press("Enter");
		await expect(page.getByRole("button", { name: `Remove ${to}` })).toBeVisible();
	}
	return composerForm(page);
}

/** Deletes the open draft through the composer, which also waits for a save still running. */
async function deleteOpenDraft(page: Page) {
	await page.getByRole("button", { name: "Delete draft" }).click();
	await expect(page.getByRole("button", { name: "Close composer" })).toHaveCount(0);
}

function isDraftSave(url: string, method: string) {
	return /^\/api\/drafts(\/[^/]+)?$/.test(new URL(url).pathname) && (method === "POST" || method === "PATCH");
}

test.describe("composer drafts", () => {
	let api: APIRequestContext;

	test.beforeEach(async () => {
		api = await apiContext(STORAGE_STATE);
		await setSendingSettings(api, { previewEnabled: false, undoSeconds: 0 });
	});

	test.afterEach(async () => {
		await api.dispose();
	});

	test("a file added to a draft is still there after closing and reopening it, and is sent once", async ({ page }) => {
		const subject = `Draft file ${uniqueToken()}`;
		await page.goto("/inbox");
		const composer = await openComposer(page, { to: RECIPIENT });
		await page.getByLabel("Subject").fill(subject);
		await page.getByRole("textbox", { name: "Message body" }).fill("The agenda is attached.");

		const stored = page.waitForResponse(
			(response) =>
				/^\/api\/drafts\/[^/]+\/attachments$/.test(new URL(response.url()).pathname) &&
				response.request().method() === "POST",
		);
		await composer.locator('input[type="file"]').setInputFiles({
			name: "agenda.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("Agenda for the planning call\n"),
		});
		expect((await stored).ok()).toBe(true);
		await page.getByRole("button", { name: "Close composer" }).click();
		await expect(page.getByLabel("Subject")).toHaveCount(0);

		const [draft] = await draftsWithSubject(api, subject);
		expect(draft, "the draft was saved").toBeDefined();
		const detail = (await (await api.get(`/api/drafts/${draft.id}`)).json()) as {
			draft: { attachments: { filename: string }[] };
		};
		expect(detail.draft.attachments.map((attachment) => attachment.filename)).toEqual(["agenda.txt"]);

		await page.goto(`/drafts/${draft.id}`);
		await expect(page.getByLabel("Subject")).toHaveValue(subject);
		await expect(composerForm(page).getByText("agenda.txt")).toBeVisible();

		const sent = page.waitForResponse(
			(response) => response.url().endsWith("/api/send") && response.request().method() === "POST",
		);
		await page.getByRole("button", { name: "Send", exact: true }).click();
		expect((await sent).ok()).toBe(true);
		await expect(page.getByText("Message sent")).toBeVisible();

		const message = await waitForMessage(api, subject, { status: "sent" });
		const sentDetail = (await (await api.get(`/api/messages/${message.id}`)).json()) as {
			attachments: { filename: string }[];
		};
		// Once from the draft, not a second time from the composer.
		expect(sentDetail.attachments.map((attachment) => attachment.filename)).toEqual(["agenda.txt"]);
		await expect.poll(async () => (await draftsWithSubject(api, subject)).length).toBe(0);
	});

	test("typing while the first autosave is still running makes one draft, not two", async ({ page }) => {
		const subject = `Rapid draft ${uniqueToken()}`;
		// Holds the POST that creates the draft, so the next edit is saved while it is in flight.
		await page.route("**/api/drafts", async (route) => {
			if (route.request().method() === "POST") await new Promise((resolve) => setTimeout(resolve, 3_000));
			await route.continue();
		});
		try {
			await page.goto("/inbox");
			await openComposer(page);
			const firstSave = page.waitForRequest(
				(request) => request.url().endsWith("/api/drafts") && request.method() === "POST",
			);
			await page.getByLabel("Subject").fill(subject);
			await firstSave;

			const lastSave = page.waitForResponse(
				(response) =>
					isDraftSave(response.url(), response.request().method()) &&
					(response.request().postData() ?? "").includes("Still typing"),
			);
			await page.getByRole("textbox", { name: "Message body" }).fill("Still typing");
			expect((await lastSave).ok()).toBe(true);

			const drafts = await draftsWithSubject(api, subject);
			expect(drafts).toHaveLength(1);
			expect(drafts[0].textBody).toContain("Still typing");
			await expect(page.getByText("Draft saved")).toBeVisible();
			await deleteOpenDraft(page);
			await expect.poll(async () => (await draftsWithSubject(api, subject)).length).toBe(0);
		} finally {
			await page.unroute("**/api/drafts");
			await deleteDrafts(api, subject);
		}
	});

	test("closing the composer right after typing still saves what was typed", async ({ page }) => {
		const subject = `Closed quickly ${uniqueToken()}`;
		try {
			await page.goto("/inbox");
			await openComposer(page);
			await page.getByLabel("Subject").fill(subject);
			await page.getByRole("textbox", { name: "Message body" }).fill("Typed just before closing");
			// Well inside the 900 ms autosave delay.
			await page.getByRole("button", { name: "Close composer" }).click();

			await expect.poll(async () => (await draftsWithSubject(api, subject)).length).toBe(1);
			const [draft] = await draftsWithSubject(api, subject);
			expect(draft.textBody).toContain("Typed just before closing");
		} finally {
			await deleteDrafts(api, subject);
		}
	});

	test("pressing Enter in Insert link adds the link without sending the message", async ({ page }) => {
		const subject = `Link draft ${uniqueToken()}`;
		const sends: string[] = [];
		page.on("request", (request) => {
			if (request.url().endsWith("/api/send")) sends.push(request.method());
		});
		try {
			await page.goto("/inbox");
			await openComposer(page, { to: RECIPIENT });
			await page.getByLabel("Subject").fill(subject);
			const body = page.getByRole("textbox", { name: "Message body" });
			await body.fill("The notes are here: ");

			await page.getByRole("button", { name: "Insert link", exact: true }).click();
			const address = page.getByPlaceholder("https://example.com");
			await address.fill("example.com/notes");
			await address.press("Enter");
			await expect(address).toBeHidden();
			await expect(body.locator('a[href="https://example.com/notes"]')).toHaveCount(1);

			await page.getByRole("button", { name: "Insert link", exact: true }).click();
			await address.fill("example.com/agenda");
			await page.getByRole("button", { name: "Apply", exact: true }).click();
			await expect(body.locator('a[href="https://example.com/agenda"]')).toHaveCount(1);

			await expect(page.getByLabel("Subject")).toHaveValue(subject);
			await expect(page.getByText("Message sent")).toHaveCount(0);
			expect(sends).toEqual([]);
			await deleteOpenDraft(page);
		} finally {
			await deleteDrafts(api, subject);
		}
	});

	test("Escape on the link Apply button closes only the popup, and Enter applies once", async ({ page }) => {
		const subject = `Link keyboard ${uniqueToken()}`;
		const sends: string[] = [];
		page.on("request", (request) => {
			if (request.url().endsWith("/api/send")) sends.push(request.method());
		});
		try {
			await page.goto("/inbox");
			await openComposer(page, { to: RECIPIENT });
			await page.getByLabel("Subject").fill(subject);
			const body = page.getByRole("textbox", { name: "Message body" });
			await body.fill("Read this: ");
			await page.getByRole("button", { name: "Open composer as modal" }).click();

			for (const [style, dark] of [
				["kite", false],
				["classic", false],
				["kite", true],
			] as const) {
				await page.evaluate(
					({ style, dark }) => {
						document.documentElement.setAttribute("data-style", style);
						document.documentElement.classList.toggle("dark", dark);
					},
					{ style, dark },
				);
				await page.getByRole("button", { name: "Insert link", exact: true }).click();
				const address = page.getByLabel("Link address");
				await address.fill("example.com/cancelled");
				await address.press("Tab");
				const apply = page.getByRole("button", { name: "Apply", exact: true });
				await expect(apply).toBeFocused();
				await apply.press("Escape");
				await expect(address).toBeHidden();
				await expect(page.getByRole("dialog", { name: "Compose message" })).toBeVisible();
				await expect(body.locator("a")).toHaveCount(0);
			}

			await body.click();
			await body.press("End");
			await page.getByRole("button", { name: "Insert link", exact: true }).click();
			await page.getByLabel("Link address").fill("example.com/keyboard");
			await page.getByLabel("Link address").press("Tab");
			await page.getByRole("button", { name: "Apply", exact: true }).press("Enter");
			await expect(body.locator('a[href="https://example.com/keyboard"]')).toHaveCount(1);
			expect(sends).toEqual([]);
			await deleteOpenDraft(page);
		} finally {
			await deleteDrafts(api, subject);
		}
	});

	test("a send time in the past is refused in the menu and when the schedule has passed", async ({ page }) => {
		const subject = `Past schedule ${uniqueToken()}`;
		const sends: string[] = [];
		page.on("request", (request) => {
			if (request.url().endsWith("/api/send")) sends.push(request.method());
		});
		try {
			await page.goto("/inbox");
			await openComposer(page, { to: RECIPIENT });
			await page.getByLabel("Subject").fill(subject);
			await page.getByRole("textbox", { name: "Message body" }).fill("This should wait.");

			await page.getByRole("button", { name: "Schedule send options" }).click();
			const when = page.locator('input[type="datetime-local"]');
			await when.fill("2020-01-01T09:00");
			await expect(page.getByRole("alert").filter({ hasText: PAST_SCHEDULE_MESSAGE })).toBeVisible();
			// The field keeps Escape to itself, so close the menu by clicking outside it.
			await page.mouse.click(5, 5);
			await expect(page.getByRole("menu")).toBeHidden();
			// The past time did not become the schedule.
			await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();

			await page.getByRole("button", { name: "Schedule send options" }).click();
			await page.getByRole("menuitem", { name: /Tomorrow morning/ }).click();
			const schedule = page.getByRole("button", { name: "Schedule", exact: true });
			await expect(schedule).toBeVisible();

			// The chosen time passes before Schedule is pressed.
			await page.clock.setFixedTime(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000));
			await schedule.click();
			await expect(page.getByText(PAST_SCHEDULE_MESSAGE)).toBeVisible();
			await expect(page.getByLabel("Subject")).toHaveValue(subject);
			expect(sends).toEqual([]);
			await deleteOpenDraft(page);
		} finally {
			await deleteDrafts(api, subject);
		}
	});

	test("the send endpoint refuses a scheduled time that has passed", async () => {
		const subject = `Past send ${uniqueToken()}`;
		const { mailboxes } = (await (await api.get("/api/mailboxes")).json()) as {
			mailboxes: { id: string; localPart: string; hostname: string }[];
		};
		const mailbox = mailboxes.find((item) => `${item.localPart}@${item.hostname}` === SUPPORT_ADDRESS);
		expect(mailbox, SUPPORT_ADDRESS).toBeDefined();
		const response = await api.post("/api/send", {
			data: {
				mailboxId: mailbox!.id,
				from: SUPPORT_ADDRESS,
				to: RECIPIENT,
				subject,
				text: "This must not go out.",
				scheduledAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
			},
		});
		expect(response.status()).toBe(400);
		expect(((await response.json()) as { error: string }).error).toBe(PAST_SCHEDULE_MESSAGE);
		const list = (await (await api.get(`/api/messages?${new URLSearchParams({ q: subject })}`)).json()) as {
			messages: unknown[];
		};
		expect(list.messages).toEqual([]);
	});
});
