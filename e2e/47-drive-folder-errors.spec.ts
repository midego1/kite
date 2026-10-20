import { expect, test } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";
import { driveAccount, signedInPage } from "./support/drive";
import { apiContext } from "./support/helpers";

test("a failed folder upload shows the error, refreshes partial folders and sends no files", async ({ browser }) => {
	const admin = await apiContext(STORAGE_STATE);
	const account = await driveAccount(admin, "drvfolder");
	const { context, page } = await signedInPage(browser, account);
	const errors: string[] = [];
	const uploads: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("request", (request) => {
		if (request.url().endsWith("/api/drive/uploads")) uploads.push(request.url());
	});
	try {
		await page.route("**/api/drive/folders", (route) =>
			route.request().postDataJSON().name === "Child"
				? route.fulfill({ status: 409, json: { error: "Could not create Child" } })
				: route.continue(),
		);
		await page.goto("/drive");
		await expect(page.getByText("Nothing here yet. Upload files or create a folder.")).toBeVisible();
		await page.locator("input[data-drive-folder-input]").evaluate((input) => {
			const file = new File(["Hello"], "hello.txt", { type: "text/plain" });
			Object.defineProperty(file, "webkitRelativePath", { value: "Parent/Child/hello.txt" });
			const transfer = new DataTransfer();
			transfer.items.add(file);
			(input as HTMLInputElement).files = transfer.files;
			input.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await expect(page.getByText("Could not create Child", { exact: true })).toBeVisible();
		await expect(page.locator('[data-drive-item="Parent"]')).toBeVisible();
		await expect(page.getByRole("region", { name: "Uploads" })).toHaveCount(0);
		expect(uploads).toEqual([]);
		expect(errors).toEqual([]);
	} finally {
		await context.close();
		await account.api.dispose();
		await admin.dispose();
	}
});
