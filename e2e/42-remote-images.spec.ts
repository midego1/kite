import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, openMessage, uniqueToken } from "./support/helpers";
import { createSignedInAccount } from "./support/auto-read";

// A 1x1 PNG.
const PIXEL = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
	"base64",
);
const OVERSIZED = Buffer.concat([PIXEL, Buffer.alloc(5 * 1024 * 1024)]);

/**
 * A stand-in image host on 127.0.0.1. Every response carries `Cross-Origin-Resource-Policy:
 * same-origin`, the header that keeps a remote image broken in the reader when the browser loads
 * it directly. The playwright config sets REMOTE_IMAGES_ALLOW_LOOPBACK so the dev server's proxy
 * may reach it; nothing else loopback is allowed.
 */
let server: Server;
let origin: string;
const hits: { path: string; headers: IncomingHttpHeaders }[] = [];

test.beforeAll(async () => {
	server = createServer((request, response) => {
		const path = request.url ?? "/";
		hits.push({ path, headers: request.headers });
		const send = (status: number, type: string, body: Buffer | string, extra: Record<string, string> = {}) => {
			response.writeHead(status, { "Content-Type": type, "Cross-Origin-Resource-Policy": "same-origin", ...extra });
			response.end(body);
		};
		if (path.startsWith("/pixel.png")) return send(200, "image/png", PIXEL, { "Set-Cookie": "tracker=1" });
		if (path === "/page.html") return send(200, "text/html", "<script>alert(1)</script>");
		if (path === "/vector.svg")
			return send(200, "image/svg+xml", "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>");
		if (path === "/fake.png") return send(200, "image/png", "<html><script>alert(1)</script></html>");
		if (path === "/huge.png") return send(200, "image/png", OVERSIZED);
		if (path === "/to-metadata")
			return send(302, "text/plain", "", { Location: "http://169.254.169.254/latest/meta-data/" });
		if (path === "/to-localhost")
			return send(302, "text/plain", "", { Location: `http://localhost:${port()}/pixel.png` });
		return send(404, "text/plain", "missing");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${port()}`;
});

test.afterAll(async () => {
	await new Promise((resolve) => server.close(resolve));
});

function port() {
	return (server.address() as AddressInfo).port;
}

function proxyPath(message: string, url: string) {
	return `/api/remote-images?${new URLSearchParams({ message, url })}`;
}

async function deliverWithImages(api: APIRequestContext, label: string, sources: string[]) {
	const subject = `${label} ${uniqueToken()}`;
	const html = `<p>Images for ${subject}</p>${sources.map((src, index) => `<img src="${src}" alt="image ${index + 1}">`).join("")}`;
	const message = await deliverInbound(api, {
		from: `"Image Sender" <images@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject,
		html,
	});
	return { subject, message };
}

test("a consented remote image whose host sends CORP same-origin shows through the authenticated proxy", async ({
	page,
}) => {
	const api = await apiContext(STORAGE_STATE);
	const imageUrl = `${origin}/pixel.png?campaign=${uniqueToken()}`;
	const { subject, message } = await deliverWithImages(api, "Corp image", [imageUrl]);
	await api.dispose();

	const proxyRequests: string[] = [];
	page.on("request", (request) => {
		if (request.url().includes("/api/remote-images")) proxyRequests.push(request.url());
	});
	const hitsBefore = hits.length;
	await page.goto("/inbox");
	await openMessage(page, subject);
	const body = page.frameLocator('iframe[title="Message body"]');
	await expect(body.getByText(`Images for ${subject}`)).toBeVisible();
	await expect(page.getByText("Remote images are hidden to protect your privacy.")).toBeVisible();
	await expect(body.getByRole("img", { name: "image 1" })).toHaveCount(0);
	expect(proxyRequests).toEqual([]);
	expect(hits.length).toBe(hitsBefore);

	await page.getByRole("button", { name: "Show images" }).click();
	const img = body.getByRole("img", { name: "image 1" });
	await expect(img).toHaveAttribute("src", proxyPath(message.id, imageUrl));
	await expect
		.poll(() => img.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth))
		.toBe(1);

	const upstream = hits.slice(hitsBefore).filter((hit) => hit.path.startsWith("/pixel.png"));
	expect(upstream.length).toBeGreaterThan(0);
	for (const hit of upstream) {
		expect(hit.headers.cookie).toBeUndefined();
		expect(hit.headers.authorization).toBeUndefined();
		expect(hit.headers.referer).toBeUndefined();
		expect(hit.headers["user-agent"]).toBe("Kite-Remote-Images/1.0");
	}

	const response = await page.request.get(proxyPath(message.id, imageUrl));
	expect(response.status()).toBe(200);
	expect(response.headers()["content-type"]).toBe("image/png");
	expect(response.headers()["x-content-type-options"]).toBe("nosniff");
	expect(response.headers()["cross-origin-resource-policy"]).toBe("same-origin");
	expect(response.headers()["cache-control"]).toBe("private, max-age=3600");
	expect(response.headers()["content-security-policy"]).toBe("default-src 'none'; sandbox");
	expect(response.headers()["set-cookie"]).toBeUndefined();
});

test("the proxy refuses callers, URLs and responses it must not serve", async () => {
	const api = await apiContext(STORAGE_STATE);
	const sources = [
		`${origin}/pixel.png`,
		`${origin}/page.html`,
		`${origin}/vector.svg`,
		`${origin}/fake.png`,
		`${origin}/huge.png`,
		`${origin}/to-metadata`,
		`${origin}/to-localhost`,
		"http://169.254.169.254/latest/meta-data/",
		`http://localhost:${port()}/pixel.png`,
		"https://images.example.com:8443/a.png",
	];
	const { message } = await deliverWithImages(api, "Refused images", sources);
	const status = async (client: APIRequestContext, url: string, id = message.id) =>
		(await client.get(proxyPath(id, url))).status();

	const anonymous = await apiContext();
	expect(await status(anonymous, `${origin}/pixel.png`)).toBe(401);
	await anonymous.dispose();

	const stranger = await createSignedInAccount(api, `images${Date.now().toString(36)}`);
	expect(await status(stranger.api, `${origin}/pixel.png`)).toBe(404);
	await stranger.api.dispose();

	const hitsBefore = hits.length;
	expect(await status(api, `${origin}/not-in-the-message.png`)).toBe(404);
	expect(await status(api, "http://169.254.169.254/latest/meta-data/")).toBe(400);
	expect(await status(api, `http://localhost:${port()}/pixel.png`)).toBe(400);
	expect(await status(api, "https://images.example.com:8443/a.png")).toBe(400);
	expect((await api.get("/api/remote-images")).status()).toBe(400);
	expect(hits.length).toBe(hitsBefore);

	expect(await status(api, `${origin}/page.html`)).toBe(415);
	expect(await status(api, `${origin}/vector.svg`)).toBe(415);
	expect(await status(api, `${origin}/fake.png`)).toBe(415);
	expect(await status(api, `${origin}/huge.png`)).toBe(413);
	expect(await status(api, `${origin}/to-metadata`)).toBe(400);
	expect(await status(api, `${origin}/to-localhost`)).toBe(400);
	expect(hits.slice(hitsBefore).map((hit) => hit.path)).not.toContain("/pixel.png");
	expect(await status(api, `${origin}/pixel.png`)).toBe(200);
	await api.dispose();
});
