import { expect, type Locator } from "@playwright/test";

/**
 * Chooses an option in a Kite Select (`src/components/ui/select.tsx`, a Radix listbox rather than a native
 * select, so Playwright's `selectOption` does not apply). A string matches an option's value or its label.
 */
export async function chooseOption(select: Locator, option: string | { label: string }): Promise<void> {
	await select.click();
	const listbox = select.page().getByRole("listbox");
	await expect(listbox).toBeVisible();
	const item =
		typeof option === "string"
			? listbox
					.locator(`[role="option"][data-value="${option}"]`)
					.or(listbox.getByRole("option", { name: option, exact: true }))
			: listbox.getByRole("option", { name: option.label, exact: true });
	await item.click();
	await expect(listbox).toBeHidden();
}

/** A Kite Select's options, read by opening it and closing it again with Escape. */
export async function readOptions(select: Locator): Promise<Array<{ value: string; label: string }>> {
	await select.click();
	const listbox = select.page().getByRole("listbox");
	await expect(listbox).toBeVisible();
	const options = await listbox
		.getByRole("option")
		.evaluateAll((items) =>
			items.map((item) => ({ value: item.getAttribute("data-value") ?? "", label: item.textContent?.trim() ?? "" })),
		);
	await select.page().keyboard.press("Escape");
	await expect(listbox).toBeHidden();
	return options;
}

/** Asserts a Kite Select's current value (the trigger mirrors it in `data-value`). */
export async function expectSelectValue(select: Locator, value: string | RegExp): Promise<void> {
	await expect(select).toHaveAttribute("data-value", value);
}
