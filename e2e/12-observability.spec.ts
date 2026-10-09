import { expect, test } from "@playwright/test";

// Correlation works through the actual Worker, not just the trace helper.
test("API responses preserve a validated trace and create a new span", async ({ request }) => {
	const traceId = "1234567890abcdef1234567890abcdef";
	const parentId = "1234567890abcdef";
	const response = await request.get("/api/setup/status", {
		headers: { traceparent: `00-${traceId}-${parentId}-01` },
	});
	expect(response.ok()).toBe(true);
	const traceparent = response.headers().traceparent;
	expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
	expect(traceparent.split("-")[1]).toBe(traceId);
	expect(traceparent.split("-")[2]).not.toBe(parentId);
});

test("invalid trace headers are replaced rather than reflected", async ({ request }) => {
	const response = await request.get("/api/setup/status", { headers: { traceparent: "invalid@example.com" } });
	expect(response.ok()).toBe(true);
	expect(response.headers().traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
});
