import { expect, test } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";
import { driveAccount, signedInPage } from "./support/drive";
import { apiContext } from "./support/helpers";

test("cancelling while an upload starts discards the session without sending any parts", async ({ browser }) => {
	const admin = await apiContext(STORAGE_STATE);
	const account = await driveAccount(admin, "drvcancel");
	const { context, page } = await signedInPage(browser, account);
	let releaseSession = () => {};
	const held = new Promise<void>((resolve) => {
		releaseSession = resolve;
	});
	const sent: string[] = [];
	page.on("request", (request) => {
		if (/\/api\/drive\/uploads\/[^/]+\/(parts\/|complete)/.test(request.url())) sent.push(request.url());
	});
	try {
		await page.route("**/api/drive/uploads", async (route) => {
			const response = await route.fetch();
			await held;
			await route.fulfill({ response });
		});
		await page.goto("/drive");
		await expect(page.getByText("Nothing here yet. Upload files or create a folder.")).toBeVisible();
		const started = page.waitForRequest((request) => request.url().endsWith("/api/drive/uploads"));
		await page.locator("input[data-drive-file-input]").setInputFiles({
			name: "cancel.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("Do not send this file"),
		});
		await started;
		await page.getByRole("button", { name: "Cancel cancel.txt", exact: true }).click();
		const discarded = page.waitForResponse(
			(response) => response.request().method() === "DELETE" && /\/api\/drive\/uploads\/[^/]+$/.test(response.url()),
		);
		releaseSession();
		expect((await discarded).ok()).toBe(true);
		await expect(page.locator('[data-drive-upload="cancelled"]')).toContainText("Cancelled");
		expect(sent).toEqual([]);
		await expect(page.locator('[data-drive-item="cancel.txt"]')).toHaveCount(0);
	} finally {
		releaseSession();
		await context.close();
		await account.api.dispose();
		await admin.dispose();
	}
});
