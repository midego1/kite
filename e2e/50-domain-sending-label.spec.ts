import { expect, test } from "@playwright/test";

test("a Cloudflare domain without a sending subdomain explains that sending is not configured", async ({ page }) => {
	const domain = {
		id: "dom-sending-label",
		hostname: "sending-label.example.test",
		zoneId: "zone-sending-label",
		status: "active",
		routingEnabled: false,
		sendingEnabled: false,
		sendingRequested: false,
		sendingProvider: "cloudflare",
		receivingProvider: "none",
	};
	await page.route(/\/api\/domains(\?.*)?$/, (route) => route.fulfill({ json: { domains: [domain] } }));
	await page.route(`**/api/domains/${domain.id}/dns`, (route) =>
		route.fulfill({
			json: {
				domain,
				dns: { routing: { records: [], missing: [] }, sending: [], sendingEnabled: false },
			},
		}),
	);
	await page.route(`**/api/domains/${domain.id}/sending`, (route) =>
		route.fulfill({ json: { cloudflare: false, resend: false, ses: false } }),
	);
	await page.goto("/domains");
	await page.getByRole("button", { name: "Show details" }).click();
	await expect(page.getByText("Sending has not been configured for this domain", { exact: true })).toBeVisible();
});
