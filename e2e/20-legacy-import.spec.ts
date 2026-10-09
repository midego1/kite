import { expect, test } from "@playwright/test";
import { apiContext } from "./support/helpers";

test("the admin overview offers the move from the old install and guards the full copy", async ({ page }) => {
	await page.goto("/admin");
	const card = page.getByTestId("legacy-import-card");
	await expect(card.getByText("Move from the old install")).toBeVisible();
	await expect(card.getByText("The old database holds 2 messages.")).toBeVisible();
	await expect(
		card.getByTestId("legacy-import-routing").getByRole("button", { name: "Check Email Routing" }),
	).toBeVisible();

	await card.getByRole("button", { name: "Copy everything" }).click();
	const dialog = page.getByRole("alertdialog", { name: "Replace everything here with the old install's data?" });
	const confirm = dialog.getByRole("button", { name: "Copy everything" });
	await expect(confirm).toBeDisabled();
	await dialog.getByRole("textbox").fill("replac");
	await expect(confirm).toBeDisabled();
	await dialog.getByRole("textbox").fill("replace");
	await expect(confirm).toBeEnabled();
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toBeHidden();
	await expect(card.getByRole("button", { name: "Copy everything" })).toBeEnabled();
});

test("the old install's status and copy need the primary admin's session", async ({ page }) => {
	const status = await page.request.get("/api/admin/legacy-import");
	expect(status.ok()).toBe(true);
	expect(await status.json()).toMatchObject({ available: true, source: { messages: 2 }, run: null });

	const anonymous = await apiContext();
	expect((await anonymous.get("/api/admin/legacy-import")).status()).toBe(401);
	expect((await anonymous.post("/api/admin/legacy-import", { data: { mode: "catch-up" } })).status()).toBe(401);
	expect((await anonymous.post("/api/admin/legacy-import/step", { data: { step: 0 } })).status()).toBe(401);
	const wrongToken = await anonymous.post("/api/admin/legacy-import/step", {
		data: { token: "x".repeat(43), step: 0 },
	});
	expect(wrongToken.status()).toBe(403);
	await anonymous.dispose();
});
