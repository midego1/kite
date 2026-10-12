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
	await page.evaluate(() => document.fonts.ready);
	await page.screenshot({ path: output, type: "png" });
} finally {
	await browser.close();
}
console.log(`Wrote ${path.relative(process.cwd(), output)}`);
