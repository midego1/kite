import { expect, test, type Page } from "@playwright/test";
import { ADMIN, STORAGE_STATE } from "./support/constants";
import { apiContext, uniqueToken } from "./support/helpers";
import { startFakeImap } from "../tests/support/fake-imap.mjs";

// Settings and Admin on a phone, a folded cover screen and an unfolded foldable/tablet (all touch screens):
// every action desktop shows must stay visible, reachable and at least 44px, whatever the width class.

const PHONE = { width: 390, height: 844 };
const FOLDED_COVER = { width: 344, height: 882 };
const UNFOLDED = { width: 884, height: 1104 };
const MIN_TAP = 44;

test.use({ hasTouch: true });

function horizontalOverflow(page: Page) {
	return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

async function expectTapTarget(page: Page, locator: ReturnType<Page["getByRole"]>) {
	await expect(locator).toBeVisible();
	const box = await locator.boundingBox();
	expect(box, "has a box").not.toBeNull();
	expect(box!.width, "width").toBeGreaterThanOrEqual(MIN_TAP);
	expect(box!.height, "height").toBeGreaterThanOrEqual(MIN_TAP);
}

test.describe("phone", () => {
	test.use({ viewport: PHONE });

	test("a mailbox rule's delete action is visible and tappable without a hover state", async ({ page }) => {
		const api = await apiContext(STORAGE_STATE);
		const mailboxes = (await (await api.get("/api/mailboxes")).json()) as { mailboxes: { id: string }[] };
		const mailboxId = mailboxes.mailboxes[0]!.id;
		const value = `mobile-${uniqueToken()}@example.test`;
		const created = await api.post("/api/routing-rules", {
			data: { mailboxId, matchField: "email", matchOperator: "contains", matchValue: value, destination: "spam" },
		});
		expect(created.ok(), await created.text()).toBe(true);
		await api.dispose();

		await page.goto("/settings/rules");
		expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
		const row = page.locator('[role="button"]').filter({ hasText: value });
		await expect(row).toBeVisible();
		const deleteButton = row.getByRole("button", { name: "Delete rule" });
		await expectTapTarget(page, deleteButton);

		await deleteButton.click();
		await page.getByRole("alertdialog").getByRole("button", { name: "Delete rule" }).click();
		await expect(page.locator('[role="button"]').filter({ hasText: value })).toHaveCount(0);
	});
});

test.describe("folded cover screen", () => {
	test.use({ viewport: FOLDED_COVER });

	test("a domain's actions menu is a full touch target and opens Remove domain", async ({ page }) => {
		await page.goto("/domains");
		expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
		const trigger = page.getByRole("button", { name: /^Actions for /i });
		await expectTapTarget(page, trigger);
		await trigger.click();
		await expect(page.getByRole("menuitem", { name: "Remove domain" })).toBeVisible();
	});
});

test.describe("unfolded foldable or tablet", () => {
	test.use({ viewport: UNFOLDED });

	test("the Settings menu rows reach 44px for a coarse pointer at this width", async ({ page }) => {
		await page.goto("/settings/account");
		expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
		await expectTapTarget(page, page.getByRole("link", { name: "My account", exact: true }));
		await expectTapTarget(page, page.getByRole("link", { name: "Appearance", exact: true }));
	});

	test("a connected account's two-way sync disclosure is a full touch target", async ({ page }) => {
		const token = uniqueToken();
		const address = `${token}@example.test`;
		const fake = await startFakeImap({ authPlain: true, users: { [address]: "app-password" }, folders: { INBOX: [] } });
		try {
			const api = await apiContext(STORAGE_STATE);
			const mailboxes = (await (await api.get("/api/mailboxes")).json()) as { mailboxes: { id: string }[] };
			const created = await api.post("/api/external-accounts", {
				data: {
					address,
					label: "Mobile two-way test",
					preset: "other",
					mailboxId: mailboxes.mailboxes[0]!.id,
					imap: { host: "127.0.0.1", port: fake.port, security: "starttls" },
					password: "app-password",
					kitePassword: ADMIN.password,
				},
			});
			expect(created.ok(), await created.text()).toBe(true);
			await api.dispose();

			await page.goto("/settings/connected-accounts");
			expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
			const toggle = page.getByRole("button", { name: /Two-way sync: choose what stays in step/ });
			await expectTapTarget(page, toggle);
			await toggle.click();
			await expect(page.getByText("When you act in Kite")).toBeVisible();
		} finally {
			await fake.close();
		}
	});
});
