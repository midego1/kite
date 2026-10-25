import { expect, test } from "@playwright/test";
import { DOMAIN } from "./support/constants";

type DomainsResponse = {
	domains?: (Record<string, unknown> & { hostname: string })[];
};

function makeDnsView(dmarcStatus: "missing" | "ok") {
	return {
		routing: { records: [], missing: [], status: "ok" },
		sending: [],
		sendingEnabled: false,
		audit: {
			mx: {
				record: "mx",
				label: "MX",
				name: DOMAIN,
				status: "ok",
				found: ["mx1.example.net"],
			},
			spf: {
				record: "spf",
				label: "SPF",
				name: DOMAIN,
				status: "ok",
				found: ["v=spf1 include:_spf.example.net ~all"],
			},
			dkim: {
				record: "dkim",
				label: "DKIM",
				name: `selector._domainkey.${DOMAIN}`,
				status: "missing",
				found: [],
			},
			dmarc: {
				record: "dmarc",
				label: "DMARC",
				name: `_dmarc.${DOMAIN}`,
				status: dmarcStatus,
				found: dmarcStatus === "ok" ? ["v=DMARC1; p=none"] : [],
			},
		},
	};
}

test("domain DNS details show DKIM and setup progress and result", async ({ page }) => {
	let domain: (Record<string, unknown> & { hostname: string }) | undefined;
	let domainsBody: DomainsResponse | null = null;
	let markSetupStarted!: () => void;
	let finishSetup!: () => void;
	const setupStarted = new Promise<void>((resolve) => {
		markSetupStarted = resolve;
	});
	const setupResponse = new Promise<void>((resolve) => {
		finishSetup = resolve;
	});

	await page.route(/\/api\/domains(?:\?.*)?$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		if (domainsBody) return route.fulfill({ json: domainsBody });
		const response = await route.fetch();
		const body = (await response.json()) as DomainsResponse;
		domain = body.domains?.find((item) => item.hostname === DOMAIN);
		if (domain) {
			domain.zoneId = "zone-e2e";
			domain.sendingProvider = "cloudflare";
		}
		domainsBody = body;
		await route.fulfill({ response, json: body });
	});

	await page.route(/\/api\/domains\/[^/]+\/dns$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		if (!domain) throw new Error("Domain list was not loaded before the DNS details");
		await route.fulfill({ json: { domain, dns: makeDnsView("missing") } });
	});

	await page.route(/\/api\/domains\/[^/]+\/dns\/setup$/, async (route) => {
		if (route.request().method() !== "POST") return route.fallback();
		if (!domain) throw new Error("Domain list was not loaded before DNS setup");
		markSetupStarted();
		await setupResponse;
		await route.fulfill({ json: { domain, dns: makeDnsView("ok") } });
	});

	await page.goto("/domains");
	await expect(page.getByText(DOMAIN, { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Show details" }).click();

	const dkimRow = page.getByText("DKIM record", { exact: true }).locator("xpath=ancestor::li[1]");
	await expect(dkimRow).toContainText("Signs outgoing email for deliverability");
	await expect(dkimRow.getByRole("button", { name: "Setup" })).toBeVisible();

	const dmarcRow = page.getByText("DMARC record", { exact: true }).locator("xpath=ancestor::li[1]");
	const setupClick = dmarcRow.getByRole("button", { name: "Setup" }).click();
	await setupStarted;
	await expect(page.getByRole("status")).toContainText(
		`Setting up the DMARC record for ${DOMAIN} in Cloudflare. This can take a moment.`,
	);

	const domainsRefresh = page.waitForResponse(
		(response) => response.url().includes("/api/domains?includeDns=true") && response.request().method() === "GET",
	);
	finishSetup();
	await setupClick;
	await expect(page.getByRole("status")).toContainText(
		`Cloudflare setup finished for ${DOMAIN}. The DMARC record is visible in public DNS.`,
	);
	await domainsRefresh;
});
