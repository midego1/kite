import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { DOMAIN, STORAGE_STATE } from "./support/constants";
import { apiContext, apiSignIn, uniqueToken } from "./support/helpers";

const MEMBER_PASSWORD = "skip-dns-member-password-123";

type DomainRow = { id: string; hostname: string; dnsSkipped?: boolean; zoneId: string; receivingProvider: string };

async function listDomains(api: APIRequestContext): Promise<DomainRow[]> {
	const response = await api.get("/api/domains");
	expect(response.ok(), await response.text()).toBe(true);
	return ((await response.json()) as { domains: DomainRow[] }).domains;
}

async function findDomain(api: APIRequestContext, hostname: string): Promise<DomainRow | undefined> {
	return (await listDomains(api)).find((domain) => domain.hostname === hostname);
}

/** The Domains page row of one domain (rows are plain blocks, found by their actions menu). */
function domainRow(page: Page, hostname: string) {
	return page.locator("div.group", { has: page.getByRole("button", { name: `Actions for ${hostname}` }) });
}

function dnsBanner(page: Page) {
	return page.getByRole("status", { name: "DNS setup" });
}

async function openInboxWithDomains(page: Page) {
	const domains = page.waitForResponse(
		(response) => new URL(response.url()).pathname === "/api/domains" && response.request().method() === "GET",
	);
	await page.goto("/inbox");
	return domains;
}

test("Skip DNS setup discards a domain check that finishes after the switch changes", async ({ page }) => {
	let releaseCheck!: () => void;
	const pendingCheck = new Promise<void>((resolve) => {
		releaseCheck = resolve;
	});
	await page.route("**/api/domains/check", async (route) => {
		await pendingCheck;
		await route.fulfill({ status: 422, json: { error: "Domain not found in Cloudflare" } });
	});
	await page.goto("/domains");
	await page.getByRole("button", { name: "New domain" }).click();
	const dialog = page.getByRole("dialog", { name: "Add domain" });
	const hostname = dialog.getByLabel("Hostname");
	const skip = dialog.getByRole("switch", { name: "Skip DNS setup" });
	await hostname.fill("not-on-cloudflare.example.test");
	const checkStarted = page.waitForRequest("**/api/domains/check");
	await skip.click();
	await checkStarted;
	await expect(skip).toHaveAttribute("aria-checked", "true");
	await expect(dialog.getByRole("button", { name: "Add domain", exact: true })).toBeEnabled();

	const checkFinished = page.waitForResponse("**/api/domains/check");
	releaseCheck();
	await (await checkFinished).finished();
	// Turning the switch back off must not reveal a stale result either.
	await skip.click();
	await expect(dialog.getByRole("alert")).toHaveCount(0);
	await expect(dialog.getByText(/Domain found in Cloudflare/)).toHaveCount(0);

	// A fresh check still reports its failure while DNS checking is enabled.
	await hostname.focus();
	await hostname.blur();
	await expect(dialog.getByRole("alert")).toHaveText("Domain not found in Cloudflare");
});

test("a domain added with DNS setup skipped is flagged until an admin marks it done", async ({ page, browser }) => {
	const hostname = `${uniqueToken("skip")}.example.test`;
	const admin = await apiContext(STORAGE_STATE);
	let domainId: string | undefined;

	try {
		await test.step("the add dialog hides the provider choices and records the domain without DNS", async () => {
			await page.goto("/domains");
			await page.getByRole("button", { name: "New domain" }).click();
			const dialog = page.getByRole("dialog", { name: "Add domain" });
			const skip = dialog.getByRole("switch", { name: "Skip DNS setup" });
			await expect(skip).toHaveAttribute("aria-checked", "false");
			await expect(dialog.getByText("Add the domain now and set up DNS records later")).toBeVisible();
			await expect(dialog.getByLabel("Receive mail with")).toBeVisible();

			await skip.click();
			await expect(skip).toHaveAttribute("aria-checked", "true");
			await expect(
				dialog.getByText("Kite will not check or change DNS. Mail will not arrive until the records are set."),
			).toBeVisible();
			await expect(dialog.getByLabel("Receive mail with")).toHaveCount(0);
			await expect(dialog.getByLabel("Send mail with")).toHaveCount(0);

			await dialog.getByLabel("Hostname").fill(hostname);
			const added = page.waitForResponse(
				(response) => new URL(response.url()).pathname === "/api/domains" && response.request().method() === "POST",
			);
			await dialog.getByRole("button", { name: "Add domain" }).click();
			const response = await added;
			expect(response.status(), await response.text()).toBe(200);
			expect(JSON.parse(response.request().postData() ?? "{}")).toEqual({ hostname, skipDns: true });
			await expect(dialog).toBeHidden();

			const domain = await findDomain(admin, hostname);
			expect(domain).toMatchObject({ dnsSkipped: true, zoneId: "manual", receivingProvider: "none" });
			domainId = domain!.id;
		});

		await test.step("the domain row says DNS was skipped and where its records go", async () => {
			const row = domainRow(page, hostname);
			await expect(row.getByText("DNS skipped")).toBeVisible();
			await expect(row.getByText("sending only")).toHaveCount(0);
			await expect(row.getByText("receiving only")).toHaveCount(0);
			await row.getByRole("button", { name: "Show details" }).click();
			await expect(row.getByText(/DNS setup was skipped when this domain was added/)).toBeVisible();
		});

		await test.step("the dashboard banner names the domain and links to the Domains page", async () => {
			await openInboxWithDomains(page);
			const banner = dnsBanner(page);
			await expect(banner).toContainText(`DNS setup was skipped for ${hostname}`);
			await expect(banner).toContainText("Mail will not arrive until its DNS records are set.");
			await expect(banner.getByRole("link", { name: "Review" })).toHaveAttribute("href", "/domains");
			// The skip link and the single main landmark are unaffected by the banner.
			await expect(page.getByRole("main")).toHaveCount(1);
			await page.keyboard.press("Tab");
			await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
		});

		await test.step("a member without domain management sees no banner and cannot clear the flag", async () => {
			const token = uniqueToken("skipm");
			const { domains } = (await (await admin.get("/api/domains")).json()) as { domains: DomainRow[] };
			const primary = domains.find((domain) => domain.hostname === DOMAIN)!;
			const created = await admin.post("/api/accounts", {
				data: { username: token, domainId: primary.id, password: MEMBER_PASSWORD, role: "user", useAllDomains: false },
			});
			expect(created.ok(), await created.text()).toBe(true);

			const member = await apiSignIn(`${token}@${DOMAIN}`, MEMBER_PASSWORD);
			const patch = await member.patch(`/api/domains/${domainId}`, { data: { dnsSkipped: false } });
			expect([403, 404]).toContain(patch.status());
			expect((await findDomain(admin, hostname))?.dnsSkipped).toBe(true);

			const context = await browser.newContext({ storageState: await member.storageState() });
			const memberPage = await context.newPage();
			const domainRequests: string[] = [];
			memberPage.on("request", (request) => {
				if (new URL(request.url()).pathname === "/api/domains") domainRequests.push(request.method());
			});
			await memberPage.goto("/inbox");
			await expect(memberPage.getByRole("main")).toBeVisible();
			await expect(dnsBanner(memberPage)).toHaveCount(0);
			expect(domainRequests).toEqual([]);
			await context.close();
			await member.dispose();
		});

		await test.step("Mark as done clears the flag and hides the banner", async () => {
			const banner = dnsBanner(page);
			const patched = page.waitForResponse(
				(response) => response.url().endsWith(`/api/domains/${domainId}`) && response.request().method() === "PATCH",
			);
			await banner.getByRole("button", { name: "Mark as done" }).click();
			expect((await patched).status()).toBe(200);
			await expect(banner).toHaveCount(0);
			expect((await findDomain(admin, hostname))?.dnsSkipped).toBe(false);

			await page.reload();
			await expect(page.getByRole("main")).toBeVisible();
			await expect(dnsBanner(page)).toHaveCount(0);

			await page.goto("/domains");
			const row = domainRow(page, hostname);
			await expect(row).toBeVisible();
			await expect(row.getByText("DNS skipped")).toHaveCount(0);
		});

		await test.step("the update endpoint accepts only dnsSkipped", async () => {
			const refused = await admin.patch(`/api/domains/${domainId}`, { data: { dnsSkipped: false, zoneId: "zone" } });
			expect(refused.status()).toBe(400);
			const notBoolean = await admin.patch(`/api/domains/${domainId}`, { data: { dnsSkipped: "no" } });
			expect(notBoolean.status()).toBe(400);
			expect((await findDomain(admin, hostname))?.zoneId).toBe("manual");
		});
	} finally {
		if (domainId) {
			const removed = await admin.delete(`/api/domains/${domainId}`);
			expect(removed.ok(), await removed.text()).toBe(true);
		}
		await admin.dispose();
	}
});
