import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

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
	// The explanatory copy above also names "assistant@<hostname>" as an example, in DOM order before the created
	// address row, so the row's own instance is the second (index 1) match rather than the only one.
	await expect(page.getByText(`assistant@${domain.hostname}`).nth(1)).toBeVisible();

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

/**
 * Settings → Assistant → Assistant by email (spec §14), scenario 7's add/verify/remove flow and scenario 8's
 * three-style/dark-mode sweep. Add/verify/remove themselves are covered at the Node level in
 * `tests/assistant-email-senders.test.mjs`, since without a dev-only capture of the code `sendSystemEmail`
 * sends, a browser test cannot read the code it would need to enter.
 */
async function mockAssistantEmailSettings(page: Page) {
	await page.route("**/api/agent/availability", (route) => route.fulfill({ json: { enabled: true } }));
	await page.route("**/api/agent/jobs?*", (route) => route.fulfill({ json: { jobs: [] } }));
	await page.route("**/api/agent/conversations?*", (route) => route.fulfill({ json: { conversations: [] } }));
	await page.route("**/api/agent/settings?*", (route) =>
		route.fulfill({
			json: {
				settings: {
					mailboxId: "demo",
					enabled: true,
					modelId: "demo",
					autoDraftEnabled: false,
					reviewerUserId: null,
					instructions: "",
					dailyLimit: 5,
				},
				models: ["demo"],
				canManage: true,
				providerConfigured: true,
				autoReplyEnabled: false,
				reviewers: [],
			},
		}),
	);
	await page.route("**/api/settings/assistant", (route) =>
		route.fulfill({
			json: {
				maxSteps: 6,
				minSteps: 1,
				maxAllowedSteps: 20,
				instructions: { general: "", chat: "", draft: "", summary: "" },
				instructionsReady: true,
				instructionsMaxLength: 2000,
				writingStyle: { enabled: false, available: true },
				emailAssistant: {
					enabled: true,
					mailboxId: "demo",
					dailyLimit: 20,
					ready: true,
					mailboxes: [{ id: "demo", label: "demo@example.com" }],
				},
			},
		}),
	);
	await page.route("**/api/settings/assistant/email-senders", (route) =>
		route.fulfill({ json: { addresses: [{ id: "ases-1", address: "me@phone.test", verified: true }] } }),
	);
	await page.route("**/api/agent/email-requests", (route) =>
		route.fulfill({
			json: {
				requests: [
					{
						id: "aer-1",
						subject: "What did Jan say about the roof quote?",
						status: "answered",
						reason: null,
						createdAt: new Date().toISOString(),
						conversationPath: "/inbox?assistant=conv-1",
					},
				],
			},
		}),
	);
}

for (const variant of [
	{ name: "kite", style: "kite", theme: "light" },
	{ name: "classic", style: "classic", theme: "light" },
	{ name: "dark", style: "kite", theme: "dark" },
]) {
	test(`the assistant-by-email settings stay usable in ${variant.name}`, async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await mockAssistantEmailSettings(page);
		await page.addInitScript(({ style, theme }) => {
			localStorage.setItem("kite-assistant-layout", "floating");
			localStorage.setItem("kite-style", style);
			localStorage.setItem("kite-theme", theme);
		}, variant);
		await page.goto("/inbox");
		const toggle = page.getByRole("button", { name: /^(Open|Close) email assistant$/ });
		await expect(toggle).toBeVisible();
		if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
		const panel = page.getByRole("region", { name: "Email assistant" });
		await panel.getByRole("button", { name: "Assistant settings" }).click();
		await expect(panel.getByText("Assistant by email")).toBeVisible();
		await expect(panel.getByText("Verified extra addresses")).toBeVisible();
		await expect(panel.getByText("me@phone.test")).toBeVisible();
		await expect(panel.getByText("Recent requests by email")).toBeVisible();
		await expect(panel.getByText("What did Jan say about the roof quote?")).toBeVisible();
		await expect(panel.getByRole("link", { name: "Open" })).toBeVisible();
	});
}

test("an address refused at the five-address limit shows the reason, not a sent-code message", async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	await mockAssistantEmailSettings(page);
	await page.route("**/api/settings/assistant/email-senders", (route) =>
		route.request().method() === "POST"
			? route.fulfill({
					status: 409,
					json: {
						error: "You can have at most 5 extra addresses. Remove one to add another.",
						code: "LIMIT_REACHED",
					},
				})
			: route.fulfill({ json: { addresses: [{ id: "ases-1", address: "me@phone.test", verified: true }] } }),
	);
	await page.addInitScript(() => localStorage.setItem("kite-assistant-layout", "floating"));
	await page.goto("/inbox");
	const toggle = page.getByRole("button", { name: /^(Open|Close) email assistant$/ });
	await expect(toggle).toBeVisible();
	if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
	const panel = page.getByRole("region", { name: "Email assistant" });
	await panel.getByRole("button", { name: "Assistant settings" }).click();
	await panel.getByLabel("New address").fill("extra@phone.test");
	await panel.getByRole("button", { name: "Add", exact: true }).click();
	await expect(panel.getByRole("status").filter({ hasText: "at most 5 extra addresses" })).toBeVisible();
	await expect(panel.getByText("a code was sent")).toHaveCount(0);
});
