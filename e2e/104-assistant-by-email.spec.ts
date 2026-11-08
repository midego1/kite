import { expect, test } from "@playwright/test";

const domain = {
	id: "dom-assistant",
	hostname: "assistant.example.test",
	zoneId: "zone-assistant",
	status: "active",
	routingEnabled: true,
	sendingEnabled: true,
	sendingRequested: true,
	sendingProvider: "cloudflare",
	receivingProvider: "cloudflare",
};

async function openDetails(page: import("@playwright/test").Page) {
	await page.route(/\/api\/domains(\?.*)?$/, (route) => route.fulfill({ json: { domains: [domain] } }));
	await page.route(`**/api/domains/${domain.id}/dns`, (route) =>
		route.fulfill({
			json: {
				domain,
				dns: { routing: { records: [], missing: [] }, sending: [], sendingEnabled: true, sendingSubdomain: null },
			},
		}),
	);
	await page.route(`**/api/domains/${domain.id}/sending`, (route) =>
		route.fulfill({ json: { cloudflare: true, resend: false, ses: false } }),
	);
	await page.route(`**/api/domains/${domain.id}/receiving`, (route) =>
		route.fulfill({ json: { cloudflare: true, resend: false, ses: false } }),
	);
	await page.goto("/domains");
	await page.getByRole("button", { name: "Show details" }).click();
}

test("an admin creates, disables and removes the domain's assistant address", async ({ page }) => {
	let address: { id: string; domainId: string; localPart: string; address: string; enabled: boolean } | null = null;
	await page.route("**/api/admin/assistant-addresses", (route) => {
		if (route.request().method() === "GET")
			return route.fulfill({ json: { assistantAddresses: address ? [address] : [] } });
		if (route.request().method() === "POST") {
			address = {
				id: "asa-1",
				domainId: domain.id,
				localPart: "assistant",
				address: `assistant@${domain.hostname}`,
				enabled: true,
			};
			return route.fulfill({ status: 201, json: { assistantAddress: address } });
		}
		return route.fallback();
	});
	await page.route("**/api/admin/assistant-addresses/asa-1", (route) => {
		if (route.request().method() === "PATCH") {
			const enabled = (route.request().postDataJSON() as { enabled: boolean }).enabled;
			address = { ...address!, enabled };
			return route.fulfill({ json: { assistantAddress: address } });
		}
		if (route.request().method() === "DELETE") {
			address = null;
			return route.fulfill({ json: { ok: true } });
		}
		return route.fallback();
	});

	await openDetails(page);
	const section = page.locator("section", { hasText: "Assistant address" });
	await expect(section.getByRole("heading", { name: "Assistant address" })).toBeVisible();
	await section.getByRole("button", { name: "Create" }).click();
	await expect(page.getByText(`assistant@${domain.hostname}`)).toBeVisible();

	await section.getByRole("button", { name: "Disable" }).click();
	await expect(section.getByRole("button", { name: "Enable" })).toBeVisible();

	await section.getByRole("button", { name: "Remove" }).click();
	await page.getByRole("alertdialog").getByRole("button", { name: "Remove address" }).click();
	await expect(section.getByRole("button", { name: "Create" })).toBeVisible();
});

test("a domain that cannot host an assistant address explains why, and creation is disabled", async ({ page }) => {
	await page.route("**/api/admin/assistant-addresses", (route) => route.fulfill({ json: { assistantAddresses: [] } }));
	const notReady = { ...domain, id: "dom-not-ready", status: "pending" };
	await page.route(/\/api\/domains(\?.*)?$/, (route) => route.fulfill({ json: { domains: [notReady] } }));
	await page.route(`**/api/domains/${notReady.id}/dns`, (route) =>
		route.fulfill({
			json: {
				domain: notReady,
				dns: { routing: { records: [], missing: [] }, sending: [], sendingEnabled: false, sendingSubdomain: null },
			},
		}),
	);
	await page.route(`**/api/domains/${notReady.id}/sending`, (route) =>
		route.fulfill({ json: { cloudflare: false, resend: false, ses: false } }),
	);
	await page.route(`**/api/domains/${notReady.id}/receiving`, (route) =>
		route.fulfill({ json: { cloudflare: false, resend: false, ses: false } }),
	);
	await page.goto("/domains");
	await page.getByRole("button", { name: "Show details" }).click();
	const section = page.locator("section", { hasText: "Assistant address" });
	await expect(page.getByText("Needs an active domain receiving through")).toBeVisible();
	await expect(section.getByRole("button", { name: "Create" })).toBeDisabled();
});
