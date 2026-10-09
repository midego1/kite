import { expect, test, type Page } from "@playwright/test";

const MARKER = "__kiteE2eMarker";

async function readMarker(page: Page) {
	return page.evaluate((key) => (window as unknown as Record<string, unknown>)[key] ?? null, MARKER);
}

test("sidebar folders navigate client-side and update the URL and title", async ({ page }) => {
	await page.goto("/inbox");
	await expect(page.getByRole("link", { name: /Cannot access workspace/ })).toBeVisible();
	await expect(page).toHaveTitle(/Inbox/);
	// A full document load would wipe this; client-side navigation keeps it.
	await page.evaluate((key) => {
		(window as unknown as Record<string, unknown>)[key] = "kept";
	}, MARKER);

	const nav = page.getByRole("navigation").first();
	const folders: { link: string; path: RegExp; title: RegExp; row?: RegExp }[] = [
		{ link: "Starred", path: /\/starred$/, title: /Starred/ },
		{ link: "Sent", path: /\/sent$/, title: /Sent/, row: /Re: Cannot access workspace/ },
		{ link: "Snoozed", path: /\/snoozed$/, title: /Snoozed/ },
		{ link: "Drafts", path: /\/drafts$/, title: /Drafts/, row: /Re: Webhook retry question/ },
		{ link: "Trash", path: /\/trash$/, title: /Trash/ },
		{ link: "Inbox", path: /\/inbox$/, title: /Inbox/, row: /Cannot access workspace/ },
	];

	for (const folder of folders) {
		const link = nav.getByRole("link", { name: new RegExp(`^${folder.link}\\b`) });
		if (!(await link.isVisible())) await nav.getByRole("button", { name: "More..." }).click();
		await link.click();
		await expect(page).toHaveURL(folder.path);
		await expect(page).toHaveTitle(folder.title);
		if (folder.row) await expect(page.getByRole("main").getByRole("link", { name: folder.row }).first()).toBeVisible();
		expect(await readMarker(page), `navigating to ${folder.link} reloaded the page`).toBe("kept");
	}
});
