import { expect, test, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { STORAGE_STATE } from "./support/constants";
import { apiContext, waitForHydration } from "./support/helpers";

const WEBHOOK_API = "/api/admin/alerts/webhook";

type Received = { method?: string; contentType?: string; body: string };

let server: Server;
let port = 0;
let answer = { status: 200, body: "ok" };
const received: Received[] = [];

test.beforeAll(async () => {
	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			received.push({
				method: req.method,
				contentType: req.headers["content-type"],
				body: Buffer.concat(chunks).toString(),
			});
			res.writeHead(answer.status, { "Content-Type": "text/plain" });
			res.end(answer.body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
});

test.afterAll(async () => {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
});

test.beforeEach(() => {
	received.length = 0;
	answer = { status: 200, body: "ok" };
});

test.afterEach(async () => {
	const api = await apiContext(STORAGE_STATE);
	const cleared = await api.delete(WEBHOOK_API);
	expect(cleared.ok(), await cleared.text()).toBe(true);
	await api.dispose();
});

async function saveReceiver(page: Page) {
	await page.goto("/alerts");
	await waitForHydration(page);
	const input = page.getByLabel("Webhook URL");
	await expect(input).toBeEnabled();
	await input.fill(`http://127.0.0.1:${port}/hook`);
	await page.getByLabel("Format").selectOption({ label: "Generic JSON" });
	const saved = page.waitForResponse(
		(response) => response.url().endsWith(WEBHOOK_API) && response.request().method() === "PUT",
	);
	await page.getByRole("button", { name: "Save" }).click();
	expect((await saved).ok()).toBe(true);
	await expect(page.getByText(`127.0.0.1:${port}/…`)).toBeVisible();
}

function clickTest(page: Page) {
	const sent = page.waitForResponse((response) => response.url().endsWith(`${WEBHOOK_API}/test`));
	return page
		.getByRole("button", { name: "Send test alert" })
		.click()
		.then(() => sent);
}

test("send test alert posts JSON to a local receiver", async ({ page }) => {
	await saveReceiver(page);
	expect((await clickTest(page)).ok()).toBe(true);
	await expect(page.getByRole("status")).toHaveText("Test alert delivered.");

	expect(received).toHaveLength(1);
	expect(received[0].method).toBe("POST");
	expect(received[0].contentType).toContain("application/json");
	const body = JSON.parse(received[0].body) as Record<string, unknown>;
	expect(body).toHaveProperty("app");
	expect(Array.isArray(body.alerts)).toBe(true);
	expect(typeof body.sentAt).toBe("string");
	expect(body.test).toBe(true);
});

test("a failing receiver is reported with its HTTP status but not its body", async ({ page }) => {
	answer = { status: 500, body: "E2E_RECEIVER_BODY" };
	await saveReceiver(page);
	expect((await clickTest(page)).status()).toBe(502);
	await expect(page.getByRole("status")).toHaveText(/^Test failed: .*\(HTTP 500\)\.$/);
	expect(await page.content()).not.toContain("E2E_RECEIVER_BODY");
	expect(received).toHaveLength(1);
});
