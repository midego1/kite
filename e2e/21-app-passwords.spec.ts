import { expect, test, type APIRequestContext } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, uniqueToken } from "./support/helpers";

type ListedKey = { id: string; name: string; scopes: string; mailboxIds: string[] };

let api: APIRequestContext;
const createdKeyNames: string[] = [];

test.beforeAll(async () => {
	api = await apiContext(STORAGE_STATE);
});

test.afterAll(async () => {
	const { apiKeys } = (await (await api.get("/api/api-keys")).json()) as { apiKeys: ListedKey[] };
	for (const key of apiKeys.filter((item) => createdKeyNames.includes(item.name)))
		await api.delete(`/api/api-keys?id=${encodeURIComponent(key.id)}`);
	await api.dispose();
});

async function supportMailboxId(): Promise<string> {
	const { mailboxes } = (await (await api.get("/api/mailboxes")).json()) as {
		mailboxes: { id: string; localPart: string; hostname: string }[];
	};
	const mailbox = mailboxes.find((item) => `${item.localPart}@${item.hostname}` === SUPPORT_ADDRESS);
	expect(mailbox, SUPPORT_ADDRESS).toBeDefined();
	return mailbox!.id;
}

test("an app password is created for the chosen mailbox, listed and usable over JMAP", async ({ page }) => {
	const name = uniqueToken("phone");
	createdKeyNames.push(name);
	const supportId = await supportMailboxId();

	await page.goto("/settings/app-passwords");
	const mailboxes = page.getByRole("group", { name: "Mailboxes this app can use" });
	const support = mailboxes.getByRole("checkbox", { name: SUPPORT_ADDRESS });
	await expect(support).toBeVisible();
	for (const checkbox of await mailboxes.getByRole("checkbox").all())
		if (await checkbox.isChecked()) await checkbox.uncheck();
	const create = page.getByRole("button", { name: "Create app password" });
	await expect(create).toBeDisabled();
	await expect(mailboxes.getByText("Choose at least one mailbox.")).toBeVisible();
	await support.check();
	await expect(create).toBeEnabled();

	await page.getByLabel("Device or app name").fill(name);
	const created = page.waitForResponse(
		(response) => response.url().endsWith("/api/api-keys") && response.request().method() === "POST",
	);
	await create.click();
	const response = await created;
	expect(response.status(), await response.text()).toBe(200);
	expect(((await response.json()) as { mailboxIds: string[] }).mailboxIds).toEqual([supportId]);

	const password = page.getByRole("button", { name: "Copy Password (API key)" }).locator("xpath=..").locator("code");
	await expect(password).toHaveText(/^\S{20,}$/);
	const key = (await password.textContent())!.trim();

	await page.getByText("This key is shown once").getByRole("link", { name: "API keys" }).click();
	await expect(page).toHaveURL(/\/settings\/api-keys$/);
	const row = page
		.locator("strong", { hasText: name })
		.locator("xpath=ancestor::div[contains(@class, 'rounded-lg')][1]");
	await expect(row).toBeVisible();
	await expect(row).toContainText("jmap");
	await expect(row).toContainText(`Mailboxes: ${SUPPORT_ADDRESS}`);

	// A JMAP client sees only the mailbox the key was granted.
	const jmap = { Authorization: `Bearer ${key}`, Origin: "" };
	const session = await api.get("/jmap/session", { headers: jmap });
	expect(session.status(), await session.text()).toBe(200);
	const { apiUrl, primaryAccounts } = (await session.json()) as {
		apiUrl: string;
		primaryAccounts: Record<string, string>;
	};
	const accountId = primaryAccounts["urn:ietf:params:jmap:mail"];
	const result = await api.post(new URL(apiUrl).pathname, {
		headers: jmap,
		data: {
			using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
			methodCalls: [["Mailbox/get", { accountId, ids: null }, "m"]],
		},
	});
	expect(result.status(), await result.text()).toBe(200);
	const [[method, { list }]] = (await result.json()).methodResponses as [string, { list: { id: string }[] }][];
	expect(method).toBe("Mailbox/get");
	expect(list.length).toBeGreaterThan(0);
	for (const mailbox of list) expect(mailbox.id.split("~")[0]).toBe(supportId);
});

test("the form shows the server's validation error instead of a generic failure", async ({ page }) => {
	// The shape `POST /api/api-keys` answers for invalid input (zod's flatten()).
	const refusal = { formErrors: [], fieldErrors: { mailboxIds: ["Too big: expected array to have <=30 items"] } };
	await page.route("**/api/api-keys", (route) =>
		route.request().method() === "POST" ? route.fulfill({ status: 400, json: { error: refusal } }) : route.fallback(),
	);
	await page.goto("/settings/app-passwords");
	await expect(
		page.getByRole("group", { name: "Mailboxes this app can use" }).getByRole("checkbox", { name: SUPPORT_ADDRESS }),
	).toBeVisible();
	await page.getByRole("button", { name: "Create app password" }).click();
	await expect(page.locator("form").getByRole("alert")).toHaveText(
		"mailboxIds: Too big: expected array to have <=30 items",
	);
});
