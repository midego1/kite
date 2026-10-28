import type { Locator } from "@playwright/test";

/**
 * The relative luminance (0 black, 1 white) of one element's text colour and of another element's own background
 * colour. The browser turns any CSS colour syntax (rgb(), oklch(), …) into pixels on a canvas first.
 */
export async function luminancesBetween(
	text: Locator,
	background: Locator = text,
): Promise<{ text: number; background: number }> {
	const backgroundColor = await background.evaluate((element) => getComputedStyle(element).backgroundColor);
	return text.evaluate((element, backdrop) => {
		const context = document.createElement("canvas").getContext("2d")!;
		const rgb = (color: string) => {
			context.clearRect(0, 0, 1, 1);
			context.fillStyle = color;
			context.fillRect(0, 0, 1, 1);
			return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
		};
		const luminance = (value: number[]) => {
			const [r, g, b] = value.map((channel) => {
				const c = channel / 255;
				return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
			});
			return 0.2126 * r + 0.7152 * g + 0.0722 * b;
		};
		return { text: luminance(rgb(getComputedStyle(element).color)), background: luminance(rgb(backdrop)) };
	}, backgroundColor);
}

/** The WCAG contrast ratio between one element's text colour and another element's own background colour. */
export async function contrastBetween(text: Locator, background: Locator = text): Promise<number> {
	const luminances = await luminancesBetween(text, background);
	const [high, low] = [luminances.text, luminances.background].sort((x, y) => y - x);
	return (high + 0.05) / (low + 0.05);
}
