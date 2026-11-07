import { expect, test, type APIRequestContext } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";
import { FAKE_ABUSE_CH_KEYS, startFakeAbuseCh, type FakeAbuseCh } from "./support/fake-abuse-ch";
import { apiContext } from "./support/helpers";

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
