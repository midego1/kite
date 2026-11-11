import { expect, test, type APIRequestContext } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";
import { sql } from "./support/drive";
import { FAKE_ABUSE_CH_KEYS, startFakeAbuseCh, type FakeAbuseCh } from "./support/fake-abuse-ch";
import { apiContext, uniqueToken, waitForHydration } from "./support/helpers";

type Checklist = { dismissed: boolean; items: { id: string; done: boolean }[] };

async function readChecklist(api: APIRequestContext): Promise<Checklist> {
	const response = await api.get("/api/admin/onboarding-checklist");
	expect(response.ok(), await response.text()).toBe(true);
	return (await response.json()) as Checklist;
}

function doneOf(checklist: Checklist, id: string): boolean | undefined {
	return checklist.items.find((item) => item.id === id)?.done;
}

test.describe("the owner setup checklist", () => {
	let api: APIRequestContext;
	let abuseCh: FakeAbuseCh;
	let wasDismissed: boolean;

	test.beforeAll(async () => {
		api = await apiContext(STORAGE_STATE);
		abuseCh = await startFakeAbuseCh();
		// A clean slate regardless of what an earlier run left behind.
		await api.delete("/api/admin/threat-lookups/key");
		wasDismissed = (await readChecklist(api)).dismissed;
		if (wasDismissed) await api.patch("/api/admin/onboarding-checklist", { data: { dismissed: false } });
	});

	test.afterAll(async () => {
		await api.delete("/api/admin/threat-lookups/key");
		await api.patch("/api/admin/onboarding-checklist", { data: { dismissed: wasDismissed } });
		await api.dispose();
		await abuseCh.close();
	});

	test("items read real state: the install's own mailbox and domain are already done, phishing lookups are not", async () => {
		const checklist = await readChecklist(api);
		expect(checklist.dismissed).toBe(false);
		expect(checklist.items.map((item) => item.id)).toEqual([
			"domain",
			"mailbox",
			"invite",
			"modules",
			"spam",
			"assistant",
			"backups",
			"updates",
		]);
		expect(doneOf(checklist, "domain")).toBe(true);
		expect(doneOf(checklist, "mailbox")).toBe(true);
		expect(doneOf(checklist, "spam")).toBe(false);
	});

	test("saving the abuse.ch key on the General page flips the phishing item to done, without clicking the checklist", async ({
		page,
	}) => {
		const saved = await api.put("/api/admin/threat-lookups/key", { data: { authKey: FAKE_ABUSE_CH_KEYS.works } });
		expect(saved.ok(), await saved.text()).toBe(true);
		expect(doneOf(await readChecklist(api), "spam")).toBe(true);

		await page.goto("/admin");
		const card = page.getByTestId("onboarding-checklist");
		await expect(card).toBeVisible();
		await expect(card.getByText("Get started")).toBeVisible();
		await expect(card.getByTestId("onboarding-item-spam")).toHaveAttribute("data-done", "true");
		await expect(card.getByTestId("onboarding-item-modules")).toBeVisible();

		await api.delete("/api/admin/threat-lookups/key");
		expect(doneOf(await readChecklist(api), "spam")).toBe(false);
	});

	test("dismissing hides it on the admin overview, stays hidden after a reload, and a link there brings it back", async ({
		page,
	}) => {
		await page.goto("/admin");
		const card = page.getByTestId("onboarding-checklist");
		await expect(card).toBeVisible();
		await card.getByRole("button", { name: "Dismiss" }).click();
		await expect(card).toHaveCount(0);
		const restore = page.getByTestId("onboarding-checklist-restore");
		await expect(restore).toContainText("dismissed");

		await page.reload();
		await expect(page.getByTestId("onboarding-checklist")).toHaveCount(0);
		await expect(page.getByTestId("onboarding-checklist-restore")).toBeVisible();
		expect((await readChecklist(api)).dismissed).toBe(true);

		await page.getByTestId("onboarding-checklist-restore").getByRole("button", { name: "Show it again" }).click();
		await expect(page.getByTestId("onboarding-checklist")).toBeVisible();
		await expect(page.getByTestId("onboarding-checklist-restore")).toHaveCount(0);
		expect((await readChecklist(api)).dismissed).toBe(false);
	});
});

/** `/setup` renders first-run registration only while no admin exists; the real admins come back in `finally`. */
async function withoutAdmins<T>(run: () => Promise<T>): Promise<T> {
	sql(
		"CREATE TABLE e2e_checklist_admins AS SELECT id FROM users WHERE role = 'admin'; UPDATE users SET role = 'user' WHERE id IN (SELECT id FROM e2e_checklist_admins);",
	);
	try {
		return await run();
	} finally {
		sql(
			"UPDATE users SET role = 'admin' WHERE id IN (SELECT id FROM e2e_checklist_admins); DROP TABLE e2e_checklist_admins;",
		);
	}
}

test.describe("reaching the checklist after first registration", () => {
	// A fresh browser: the default storage state is the suite's own admin, already signed in, which /login would
	// bounce straight past.
	test.use({ storageState: { cookies: [], origins: [] } });

	test("a freshly registered owner's first sign-in opens the admin overview and its checklist, not the inbox", async ({
		page,
	}) => {
		const username = uniqueToken("checklistowner");
		const domain = `${uniqueToken("checklistdomain")}.test`;
		const password = "checklist-owner-pw-1";

		try {
			await withoutAdmins(async () => {
				const anonymous = await apiContext();
				try {
					const response = await anonymous.post("/api/auth/register", {
						data: {
							domain,
							username,
							password,
							resetEmail: `${username}-recovery@example.net`,
							skipDns: true,
							usageStatistics: false,
						},
					});
					const body = (await response.json()) as { redirect?: string };
					expect(response.ok(), JSON.stringify(body)).toBe(true);
					expect(body.redirect).toBe("/login?setup=1");

					await page.goto(body.redirect!);
					await waitForHydration(page);
					await page.getByLabel("Email").fill(`${username}@${domain}`);
					await page.getByLabel("Password").fill(password);
					await page.getByRole("button", { name: "Sign in", exact: true }).click();
					await expect(page).toHaveURL(/\/admin$/);
					await expect(page.getByTestId("onboarding-checklist")).toBeVisible();
					await expect(page.getByTestId("onboarding-item-mailbox")).toHaveAttribute("data-done", "true");
				} finally {
					await anonymous.dispose();
				}
			});
		} finally {
			// A no-op DELETE when registration itself never created the row.
			sql(`DELETE FROM users WHERE email = '${username}@${domain}'`);
		}
	});
});
