import { expect, test, type Page } from "@playwright/test";
import { DOMAIN } from "./support/constants";

// The e2e server has no AWS account, so the domain is shown as sending through SES and the
// credentials save is answered here. The body matches what PUT /api/admin/aws returns
// (tests/aws-credentials-panel.test.mjs checks the route itself).
const REFUSAL = {
	error: "These credentials work but have no SES permissions. Attach the policy shown below.",
	report: {
		accountId: "123456789012",
		arn: "arn:aws:iam::123456789012:user/kite",
		region: "us-east-1",
		sending: false,
		productionAccess: null,
		receivingRegion: true,
		receiving: false,
		sns: false,
		s3: false,
		missing: ["ses:GetAccount", "ses:SendEmail", "ses:DescribeActiveReceiptRuleSet"],
	},
	policy: {
		Version: "2012-10-17",
		Statement: [{ Effect: "Allow", Action: ["ses:GetAccount", "ses:SendEmail"], Resource: "*" }],
	},
};

async function openSesCredentials(page: Page, save: { status: number; json: unknown }) {
	await page.route(/\/api\/domains(\?.*)?$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		const response = await route.fetch();
		const body = (await response.json()) as { domains?: { hostname: string; sendingProvider: string }[] };
		for (const domain of body.domains ?? []) if (domain.hostname === DOMAIN) domain.sendingProvider = "ses";
		await route.fulfill({ response, json: body });
	});
	await page.route(/\/api\/domains\/[^/]+\/ses$/, (route) =>
		route.request().method() === "GET" ? route.fulfill({ json: { credentials: false, ses: null } }) : route.fallback(),
	);
	await page.route("**/api/admin/aws", (route) =>
		route.request().method() === "PUT" ? route.fulfill(save) : route.fallback(),
	);
	await page.goto("/domains");
	await page
		.getByText(DOMAIN, { exact: true })
		.locator("xpath=ancestor::div[.//button[normalize-space()='Show details']][1]")
		.getByRole("button", { name: "Show details" })
		.click();
	const accessKey = page.getByPlaceholder("Access key ID (AKIA…)");
	await expect(accessKey).toBeVisible();
	await accessKey.fill("AKIAIOSFODNN7EXAMPLE");
	await page.getByPlaceholder("Secret access key").fill("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
	await page.getByRole("button", { name: "Validate and save" }).click();
}

test("a save refused for missing permissions shows them with the IAM policy, open", async ({ page }) => {
	await openSesCredentials(page, { status: 400, json: REFUSAL });
	await expect(page.getByRole("alert").filter({ hasText: "no SES permissions" })).toBeVisible();
	const details = page.locator("details").filter({ hasText: "Missing permissions and the IAM policy" });
	await expect(details).toHaveAttribute("open", "");
	await expect(details).toContainText("Missing: ses:GetAccount, ses:SendEmail, ses:DescribeActiveReceiptRuleSet");
	await expect(details.locator("pre")).toContainText('"ses:SendEmail"');
	// The form stays open so the admin can retry after attaching the policy.
	await expect(page.getByPlaceholder("Access key ID (AKIA…)")).toHaveValue("AKIAIOSFODNN7EXAMPLE");
});

test("a refusal without a capability report shows only the message", async ({ page }) => {
	await openSesCredentials(page, {
		status: 400,
		json: { error: "AWS rejected these credentials. Check the access key ID and secret." },
	});
	await expect(page.getByRole("alert").filter({ hasText: "AWS rejected these credentials" })).toBeVisible();
	await expect(page.locator("details").filter({ hasText: "Missing permissions" })).toHaveCount(0);
});
