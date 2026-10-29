import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(here, "../../docs/assets/social-preview.png");

await mkdir(path.dirname(output), { recursive: true });
const browser = await chromium.launch();
try {
	const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
	await page.goto(pathToFileURL(path.join(here, "social-preview.html")).href);
	// The card must be set in Manrope, not a fallback: load the weights it uses and check they arrived.
	await page.evaluate(() => Promise.all(["400", "700", "800"].map((weight) => document.fonts.load(`${weight} 36px Manrope`))));
	await page.evaluate(() => document.fonts.ready);
	const manropeLoaded = await page.evaluate(() => document.fonts.check("800 104px Manrope"));
	if (!manropeLoaded) throw new Error("Manrope did not load; the social preview would use a fallback font");
	await page.screenshot({ path: output, type: "png" });
} finally {
	await browser.close();
}
console.log(`Wrote ${path.relative(process.cwd(), output)}`);
