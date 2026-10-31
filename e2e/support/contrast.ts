import type { Locator } from "@playwright/test";

/**
 * The relative luminance (0 black, 1 white) of one element's text colour and of another element's background as
 * it shows: a translucent background (bg-x/8, rgba borders of a wash) is composited over its ancestors' down to
 * the first opaque one, or white, and a translucent text colour over that result. The browser turns any CSS colour
 * syntax (rgb(), oklch(), color-mix(), …) into pixels on a canvas, which also does the compositing. Background
 * images such as gradients are not drawn.
 */
export async function luminancesBetween(
	text: Locator,
	background: Locator = text,
): Promise<{ text: number; background: number }> {
	const layers = await background.evaluate((element) => {
		const colors: string[] = [];
		for (let node: Element | null = element; node; node = node.parentElement) {
			const color = getComputedStyle(node).backgroundColor;
			colors.push(color);
			// An opaque layer hides everything under it.
			const probe = document.createElement("canvas").getContext("2d")!;
			probe.fillStyle = color;
			probe.fillRect(0, 0, 1, 1);
			if (probe.getImageData(0, 0, 1, 1).data[3] === 255) break;
		}
		return colors;
	});
	return text.evaluate((element, backgroundLayers) => {
		const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
		const pixel = () => Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
		const paint = (color: string) => {
			context.fillStyle = color;
			context.fillRect(0, 0, 1, 1);
		};
		const luminance = (value: number[]) => {
			const [r, g, b] = value.map((channel) => {
				const c = channel / 255;
				return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
			});
			return 0.2126 * r + 0.7152 * g + 0.0722 * b;
		};
		// The page's own base, then each layer from the outermost in.
		paint("#fff");
		for (const color of [...backgroundLayers].reverse()) paint(color);
		const backdrop = pixel();
		paint(getComputedStyle(element).color);
		return { text: luminance(pixel()), background: luminance(backdrop) };
	}, layers);
}

/**
 * The WCAG contrast ratio between one element's text colour and another element's background as it shows (see
 * `luminancesBetween`).
 */
export async function contrastBetween(text: Locator, background: Locator = text): Promise<number> {
	const luminances = await luminancesBetween(text, background);
	const [high, low] = [luminances.text, luminances.background].sort((x, y) => y - x);
	return (high + 0.05) / (low + 0.05);
}
