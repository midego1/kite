import type { Locator } from "@playwright/test";

/** The WCAG contrast ratio between one element's text colour and another element's own background colour. */
export async function contrastBetween(text: Locator, background: Locator = text): Promise<number> {
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
		const [high, low] = [luminance(rgb(getComputedStyle(element).color)), luminance(rgb(backdrop))].sort(
			(x, y) => y - x,
		);
		return (high + 0.05) / (low + 0.05);
	}, backgroundColor);
}
