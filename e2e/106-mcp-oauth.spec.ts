import { createHash, randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN, STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext } from "./support/helpers";
import { mcpCall, mcpToolNames } from "./support/mcp";

// MCP over OAuth 2.1 end to end: discovery from the 401 of /mcp, Dynamic Client Registration, the consent screen in
// the browser (only Read mail ticked), the code exchange with PKCE, an MCP tool call with the access token, a tool
// outside the approved scopes refused, a refresh, and every token refused after Revoke in Settings → MCP apps.

// The client's loopback redirect; nothing listens there, the browser's request is intercepted.
const REDIRECT_URI = "http://127.0.0.1:45931/callback";
const CLIENT_NAME = "E2E OAuth client";

type Tokens = { access_token: string; refresh_token: string; scope: string; token_type: string; expires_in: number };

let api: APIRequestContext;
/** Requests an MCP client makes: no cookies and no Origin header. */
let client: APIRequestContext;

test.beforeAll(async () => {
	api = await apiContext(STORAGE_STATE);
	client = await apiContext();
});

test.afterAll(async () => {
	await api.dispose();
	await client.dispose();
});

const base64Url = (bytes: Buffer) => bytes.toString("base64url");

async function token(form: Record<string, string>) {
	return client.post("/api/oauth/token", { form, headers: { Origin: "" } });
}

/** Opens the consent screen and returns the URL the browser is sent back to after `act`. */
async function returnedUrl(page: Page, act: () => Promise<void>): Promise<URL> {
	const returned = new Promise<string>((resolve) => {
		void page.route(`${new URL(REDIRECT_URI).origin}/**`, async (route) => {
			resolve(route.request().url());
			await route.fulfill({ status: 200, contentType: "text/plain", body: "You can close this window." });
		});
	});
	await act();
	return new URL(await returned);
}

test("an MCP client connects with OAuth, is limited to its scopes, refreshes, and is refused after Revoke", async ({
	page,
}) => {
	// Discovery: the 401 names the Protected Resource Metadata, which names Kite as the authorization server.
	const unauthorized = await client.post("/mcp", {
		headers: { Accept: "application/json, text/event-stream", Origin: "" },
		data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
	});
	expect(unauthorized.status()).toBe(401);
	const challenge = unauthorized.headers()["www-authenticate"] ?? "";
	const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
	expect(metadataUrl, challenge).toBeTruthy();
	const resourceMetadata = (await (await client.get(new URL(metadataUrl!).pathname)).json()) as {
		resource: string;
		authorization_servers: string[];
		scopes_supported: string[];
	};
	expect(resourceMetadata.resource).toMatch(/\/mcp$/);
	expect(resourceMetadata.scopes_supported).toContain("mcp:read");
	const server = (await (await client.get("/.well-known/oauth-authorization-server")).json()) as {
		issuer: string;
		code_challenge_methods_supported: string[];
	};
	expect(server.issuer).toBe(resourceMetadata.authorization_servers[0]);
	expect(server.code_challenge_methods_supported).toEqual(["S256"]);

	// Registration: a public client with a loopback redirect URI. A non-loopback http one is refused.
	const refused = await client.post("/api/oauth/register", {
		data: { client_name: "Bad", redirect_uris: ["http://evil.example/callback"] },
		headers: { Origin: "" },
	});
	expect(refused.status()).toBe(400);
	const registered = await client.post("/api/oauth/register", {
		data: { client_name: CLIENT_NAME, redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" },
		headers: { Origin: "" },
	});
	expect(registered.status(), await registered.text()).toBe(201);
	const { client_id: clientId } = (await registered.json()) as { client_id: string };

	// Consent in the browser, as the signed-in demo admin.
	const verifier = base64Url(randomBytes(32));
	const state = base64Url(randomBytes(16));
	const authorize = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: REDIRECT_URI,
		code_challenge: base64Url(createHash("sha256").update(verifier).digest()),
		code_challenge_method: "S256",
		state,
		resource: resourceMetadata.resource,
		scope: "mcp:read mcp:draft",
	});
	// A request without PKCE is refused in Kite: the error goes back to the app only when the user follows the link.
	const withoutPkce = new URLSearchParams(authorize);
	withoutPkce.delete("code_challenge");
	await page.goto(`/oauth/authorize?${withoutPkce}`);
	await expect(page.getByRole("heading", { name: "This app cannot connect" })).toBeVisible();
	const back = page.getByRole("link", { name: "Return to 127.0.0.1:45931" });
	await expect(back).toHaveAttribute("href", /^http:\/\/127\.0\.0\.1:45931\/callback\?error=invalid_request/);
	expect(new URL(page.url()).pathname).toBe("/oauth/authorize");

	await page.goto(`/oauth/authorize?${authorize}`);
	await expect(page.getByRole("heading", { name: `Allow ${CLIENT_NAME} to use Kite?` })).toBeVisible();
	await expect(page.getByText("127.0.0.1:45931", { exact: true })).toBeVisible();
	const read = page.getByRole("checkbox", { name: /^Read mail/ });
	const drafts = page.getByRole("checkbox", { name: /^Manage drafts/ });
	await expect(read).toBeChecked();
	await expect(drafts).not.toBeChecked();
	await expect(page.getByRole("checkbox", { name: /^Organize mail/ })).toHaveCount(0);
	const allow = page.getByRole("button", { name: "Allow" });
	await expect(allow).toBeDisabled();
	await page.getByRole("checkbox", { name: SUPPORT_ADDRESS }).click();
	await expect(allow).toBeEnabled();
	const callback = await returnedUrl(page, () => allow.click());
	expect(callback.searchParams.get("state")).toBe(state);
	expect(callback.searchParams.get("iss")).toBe(server.issuer);
	const code = callback.searchParams.get("code")!;
	expect(code).toBeTruthy();

	// The code, with the wrong verifier, is used up; a fresh consent gives a code the right verifier redeems.
	const exchange = (value: string, codeVerifier = verifier) =>
		token({
			grant_type: "authorization_code",
			code: value,
			client_id: clientId,
			redirect_uri: REDIRECT_URI,
			code_verifier: codeVerifier,
			resource: resourceMetadata.resource,
		});
	const wrong = await exchange(code, base64Url(randomBytes(32)));
	expect(wrong.status()).toBe(400);
	expect(((await wrong.json()) as { error: string }).error).toBe("invalid_grant");
	await page.goto(`/oauth/authorize?${authorize}`);
	await page.getByRole("checkbox", { name: SUPPORT_ADDRESS }).click();
	const second = await returnedUrl(page, () => page.getByRole("button", { name: "Allow" }).click());
	const exchanged = await exchange(second.searchParams.get("code")!);
	expect(exchanged.status(), await exchanged.text()).toBe(200);
	expect(exchanged.headers()["cache-control"]).toContain("no-store");
	const first = (await exchanged.json()) as Tokens;
	expect(first.token_type).toBe("Bearer");
	expect(first.scope).toBe("mcp:read");

	// The access token calls a read tool; drafting was not approved, so its tools are absent and refused.
	const names = await mcpToolNames(client, first.access_token);
	expect(names).toContain("list_emails");
	expect(names).not.toContain("draft_email");
	const { mailboxes } = (await (await api.get("/api/mailboxes")).json()) as {
		mailboxes: { id: string; localPart: string }[];
	};
	const supportId = mailboxes.find((mailbox) => mailbox.localPart === "support")!.id;
	const listed = await mcpCall(client, first.access_token, "tools/call", {
		name: "list_emails",
		arguments: { mailboxId: supportId, limit: 1 },
	});
	expect(listed.error, JSON.stringify(listed)).toBeUndefined();
	expect((listed.result as { isError?: boolean }).isError).toBeFalsy();
	const drafted = await mcpCall(client, first.access_token, "tools/call", {
		name: "draft_email",
		arguments: { mailboxId: supportId, to: "someone@example.net", subject: "Hi", body: "Hello" },
	});
	expect(drafted.error ?? (drafted.result as { isError?: boolean }).isError, JSON.stringify(drafted)).toBeTruthy();
	// OAuth tokens are bound to /mcp: the REST API refuses them.
	expect(
		(await client.get("/api/v1/messages", { headers: { Authorization: `Bearer ${first.access_token}` } })).status(),
	).toBe(401);

	// Refresh: a new pair; the old access token stops working.
	const refreshed = await token({
		grant_type: "refresh_token",
		refresh_token: first.refresh_token,
		client_id: clientId,
	});
	expect(refreshed.status(), await refreshed.text()).toBe(200);
	const renewed = (await refreshed.json()) as Tokens;
	expect(renewed.refresh_token).not.toBe(first.refresh_token);
	expect(
		(
			await client.post("/mcp", { headers: { Authorization: `Bearer ${first.access_token}`, Origin: "" }, data: {} })
		).status(),
	).toBe(401);
	expect(await mcpToolNames(client, renewed.access_token)).toContain("list_emails");

	// Settings → MCP apps lists the app; Revoke ends its access.
	await page.goto("/settings/mcp-apps");
	await expect(page.getByRole("heading", { level: 1, name: "MCP apps" })).toBeVisible();
	const row = page.locator("[data-mcp-app]").filter({ hasText: CLIENT_NAME });
	await expect(row).toHaveCount(1);
	await expect(row).toContainText("127.0.0.1:45931");
	await expect(row).toContainText("Read mail");
	await row.getByRole("button", { name: "Revoke" }).click();
	await page.getByRole("button", { name: "Revoke access" }).click();
	await expect(row).toHaveCount(0);
	const afterRevoke = await client.post("/mcp", {
		headers: {
			Authorization: `Bearer ${renewed.access_token}`,
			Accept: "application/json, text/event-stream",
			Origin: "",
		},
		data: { jsonrpc: "2.0", id: 2, method: "tools/list" },
	});
	expect(afterRevoke.status()).toBe(401);
	expect(afterRevoke.headers()["www-authenticate"]).toContain('error="invalid_token"');
	const deadRefresh = await token({
		grant_type: "refresh_token",
		refresh_token: renewed.refresh_token,
		client_id: clientId,
	});
	expect(deadRefresh.status()).toBe(400);
});

test("a signed-out visitor signs in first and returns to the consent screen; an unknown client is never redirected", async ({
	browser,
}) => {
	const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const page = await context.newPage();
	await page.goto(
		`/oauth/authorize?client_id=mcpc_unknown&redirect_uri=${encodeURIComponent("https://evil.example/cb")}`,
	);
	await expect(page).toHaveURL(/\/login\?next=%2Foauth%2Fauthorize/);
	await page.getByLabel("Email", { exact: true }).fill(ADMIN.email);
	await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page).toHaveURL(/\/oauth\/authorize\?client_id=mcpc_unknown/);
	await expect(page.getByRole("heading", { name: "This app cannot connect" })).toBeVisible();
	expect(page.url()).not.toContain("evil.example/cb?");
	await context.close();
});
