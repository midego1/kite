import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function mockAssistant(page: Page) {
	await page.route("**/api/agent/availability", (route) => route.fulfill({ json: { enabled: true } }));
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
	await page.route("**/api/agent/jobs?*", (route) => route.fulfill({ json: { jobs: [] } }));
	await page.route("**/api/agent/conversations?*", (route) =>
		route.fulfill({ json: { conversations: [{ id: "design-conversation", title: "Design example" }] } }),
	);
	await page.route("**/api/agent/conversations/design-conversation?*", (route) =>
		route.fulfill({
			json: {
				messages: [
					{ id: "user", role: "user", content: "Write a friendly reply saying I'll review the files today." },
					{
						id: "draft-tool",
						role: "tool",
						toolName: "draft_reply",
						content: JSON.stringify({ draftId: "design-draft", revision: 1, status: "draft_created" }),
					},
					{ id: "assistant", role: "assistant", content: "Here's a draft for Sophie:" },
				],
			},
		}),
	);
	await page.route("**/api/drafts/design-draft", (route) =>
		route.fulfill({
			json: {
				draft: {
					id: "design-draft",
					mailboxId: null,
					fromAddr: "admin@example.com",
					toAddr: "sophie@example.com",
					subject: "Re: Files to review",
					textBody:
						"Hi Sophie,\n\nThanks for sharing, this looks great! I'll review the files today and send you my feedback.\n\nBest,\nAlex",
					htmlBody: null,
				},
			},
		}),
	);
}

for (const variant of [
	{ name: "kite", style: "kite", theme: "light" },
	{ name: "classic", style: "classic", theme: "light" },
	{ name: "dark", style: "kite", theme: "dark" },
]) {
	test(`the redesigned assistant keeps chat and draft controls usable in ${variant.name}`, async ({
		page,
	}, testInfo) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await mockAssistant(page);
		await page.route("**/api/agent/chat", (route) =>
			route.fulfill({
				contentType: "application/x-ndjson",
				body:
					[
						JSON.stringify({ type: "conversation", conversationId: "design-conversation" }),
						JSON.stringify({ type: "text", text: "I can help with that." }),
						JSON.stringify({ type: "done" }),
					].join("\n") + "\n",
			}),
		);
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
		await expect(panel.getByText("Your inbox assistant")).toBeVisible();
		await expect(panel.getByText("Your mailbox", { exact: true })).toBeVisible();
		await panel.getByRole("button", { name: "Assistant settings" }).click();
		await expect(panel.getByRole("spinbutton", { name: "Max steps per question" })).toBeEnabled();
		await expect(panel.getByText(/Steps can appear live/)).toBeHidden();
		await page.screenshot({ path: testInfo.outputPath(`settings-${variant.name}.png`) });
		await panel.getByRole("button", { name: "Back to assistant" }).click();
		await panel.getByRole("button", { name: "New chat" }).click();
		await expect(panel.getByRole("button", { name: "Summarize recent mail" })).toBeEnabled();
		await expect(panel.getByRole("textbox", { name: "Message Kite AI" })).toBeEnabled();
		await expect(panel.getByText("Review drafts before sending.")).toBeVisible();
		const sent = page.waitForRequest((request) => request.url().endsWith("/api/agent/chat"));
		await panel.getByRole("textbox", { name: "Message Kite AI" }).fill("Help me review my mail");
		await panel.getByRole("button", { name: "Send message", exact: true }).click();
		expect((await sent).postDataJSON().text).toBe("Help me review my mail");
		await expect(panel.getByText("I can help with that.", { exact: true })).toBeVisible();
		await panel.getByRole("button", { name: "New chat" }).click();
		await panel.getByLabel("Previous chats").click();
		await panel.getByRole("button", { name: "Design example", exact: true }).click();
		const draft = panel.getByRole("region", { name: "Reply draft" });
		await expect(draft.getByText("Re: Files to review", { exact: true })).toBeVisible();
		await expect(draft.getByText("To sophie@example.com")).toBeVisible();
		await expect(draft.getByText(/Thanks for sharing/)).toBeVisible();
		await expect(draft.getByRole("button", { name: "Approve to send" })).toBeVisible();
		await expect(draft.getByRole("button", { name: "Approve to send" })).toBeInViewport();
		await page.screenshot({ path: testInfo.outputPath(`assistant-${variant.name}.png`) });
		await page.evaluate(() => localStorage.setItem("kite-column-width:assistant-window-width", "340"));
		await page.reload();
		await expect(toggle).toBeVisible();
		if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
		await expect(panel.getByRole("button", { name: "Close assistant" })).toBeVisible();
		expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
		await panel.getByLabel("Previous chats").click();
		await panel.getByRole("button", { name: "Design example", exact: true }).click();
		await expect(draft.getByRole("button", { name: "Edit draft" })).toBeVisible();
		await draft.getByRole("button", { name: "Edit draft" }).click();
		await expect(page.getByLabel("Subject")).toHaveValue("Re: Files to review");
		await expect(page.getByRole("textbox", { name: "Message body" })).toContainText("Hi Sophie");
	});
}

/** Routes registered later win, so `overrides` replaces the default draft mocks of `mockAssistant`. */
async function openDesignConversation(page: Page, overrides: () => Promise<void>) {
	await page.setViewportSize({ width: 1280, height: 900 });
	await mockAssistant(page);
	await overrides();
	await page.addInitScript(() => localStorage.setItem("kite-assistant-layout", "floating"));
	await page.goto("/inbox");
	const toggle = page.getByRole("button", { name: /^(Open|Close) email assistant$/ });
	await expect(toggle).toBeVisible();
	if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
	const panel = page.getByRole("region", { name: "Email assistant" });
	await panel.getByLabel("Previous chats").click();
	await panel.getByRole("button", { name: "Design example", exact: true }).click();
	return panel;
}

test("a draft that was already sent shows as sent instead of an unavailable preview", async ({ page }) => {
	const requests = { draft: 0, state: 0 };
	const panel = await openDesignConversation(page, async () => {
		await page.route("**/api/drafts/design-draft", (route) => {
			requests.draft++;
			return route.fulfill({ status: 404, json: { error: "Draft not found" } });
		});
		await page.route("**/api/drafts/design-draft/state", (route) => {
			requests.state++;
			return route.fulfill({
				json: { state: "sent", messageId: "sent-1", subject: "Re: Files to review", to: "sophie@example.com" },
			});
		});
	});
	const card = panel.getByRole("region", { name: "Reply draft" });
	await expect(card.getByText("Sent", { exact: true })).toBeVisible();
	await expect(card.getByText("Re: Files to review")).toBeVisible();
	await expect(card.getByText("To sophie@example.com")).toBeVisible();
	await expect(card.getByRole("link", { name: "View message" })).toHaveAttribute("href", "/sent/sent-1");
	await expect(card.getByRole("button")).toHaveCount(0);
	await expect(card.getByText("Preview unavailable")).toHaveCount(0);

	// A final card no longer listens: mail events cause no further requests.
	expect(requests).toEqual({ draft: 1, state: 1 });
	await page.evaluate(() => window.dispatchEvent(new Event("kite:messages-changed")));
	await page.waitForTimeout(600);
	expect(requests).toEqual({ draft: 1, state: 1 });
});

test("a draft that is still being sent says so, checks again, and then shows as sent without probing the draft", async ({
	page,
}) => {
	const requests = { draft: 0, state: 0 };
	const panel = await openDesignConversation(page, async () => {
		await page.route("**/api/drafts/design-draft", (route) => {
			requests.draft++;
			return route.fulfill({ status: 404, json: { error: "Draft not found" } });
		});
		await page.route("**/api/drafts/design-draft/state", (route) => {
			requests.state++;
			const details = { messageId: "sent-4", subject: "Re: Files to review", to: "sophie@example.com" };
			return route.fulfill({ json: { state: requests.state === 1 ? "sending" : "sent", ...details } });
		});
	});
	const card = panel.getByRole("region", { name: "Reply draft" });
	await expect(card.getByText("Sending…", { exact: true })).toBeVisible();
	await expect(card.getByRole("button")).toHaveCount(0);
	await expect(card.getByRole("link", { name: "View message" })).toHaveCount(0);
	await expect(card.getByText("Sent", { exact: true })).toBeVisible({ timeout: 10_000 });
	expect(requests).toEqual({ draft: 1, state: 2 });
});

test("a failed status check keeps a scheduled card as it was and tries again, never restoring the draft buttons", async ({
	page,
}) => {
	const requests = { draft: 0, state: 0 };
	const panel = await openDesignConversation(page, async () => {
		await page.route("**/api/drafts/design-draft", (route) => {
			requests.draft++;
			return route.fulfill({ status: 404, json: { error: "Draft not found" } });
		});
		await page.route("**/api/drafts/design-draft/state", (route) => {
			requests.state++;
			if (requests.state === 2) return route.fulfill({ status: 500, json: { error: "Temporary failure" } });
			const details = { messageId: "sent-5", subject: "Re: Files to review", to: "sophie@example.com" };
			return route.fulfill({
				json:
					requests.state === 1
						? { state: "scheduled", ...details, scheduledAt: new Date().toISOString() }
						: { state: "sent", ...details },
			});
		});
	});
	const card = panel.getByRole("region", { name: "Reply draft" });
	await expect(card.getByText(/^Scheduled for /)).toBeVisible();
	await expect.poll(() => requests.state, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
	await expect(card.getByText(/^Scheduled for /)).toBeVisible();
	await expect(card.getByRole("button")).toHaveCount(0);
	await expect(card.getByText("Preview unavailable")).toHaveCount(0);
	await expect(card.getByText("Sent", { exact: true })).toBeVisible({ timeout: 10_000 });
	expect(requests).toEqual({ draft: 1, state: 3 });
});

test("a scheduled draft says when it goes out and a removed draft is no longer available", async ({ page }) => {
	const panel = await openDesignConversation(page, async () => {
		await page.route("**/api/drafts/design-draft", (route) =>
			route.fulfill({ status: 404, json: { error: "Draft not found" } }),
		);
		await page.route("**/api/drafts/design-draft/state", (route) =>
			route.fulfill({
				json: {
					state: "scheduled",
					messageId: "sent-2",
					subject: "Re: Files to review",
					to: "sophie@example.com",
					scheduledAt: "2099-01-02T09:00:00.000Z",
				},
			}),
		);
	});
	const card = panel.getByRole("region", { name: "Reply draft" });
	await expect(card.getByText(/^Scheduled for /)).toBeVisible();
	await expect(card.getByRole("button")).toHaveCount(0);

	await page.unroute("**/api/drafts/design-draft/state");
	await page.route("**/api/drafts/design-draft/state", (route) => route.fulfill({ json: { state: "unavailable" } }));
	await panel.getByRole("button", { name: "New chat" }).click();
	await panel.getByLabel("Previous chats").click();
	await panel.getByRole("button", { name: "Design example", exact: true }).click();
	await expect(card.getByText("This draft is no longer available.")).toBeVisible();
	await expect(card.getByRole("button")).toHaveCount(0);
});

test("approving a draft turns its card into a sent card in the same session", async ({ page }) => {
	let sent = false;
	const panel = await openDesignConversation(page, async () => {
		await page.route("**/api/drafts/design-draft", (route) =>
			sent
				? route.fulfill({ status: 404, json: { error: "Draft not found" } })
				: route.fulfill({
						json: {
							draft: {
								id: "design-draft",
								mailboxId: null,
								fromAddr: "admin@example.com",
								toAddr: "sophie@example.com",
								subject: "Re: Files to review",
								textBody: "Hi Sophie, I'll review the files today.",
								htmlBody: null,
							},
						},
					}),
		);
		await page.route("**/api/drafts/design-draft/state", (route) =>
			route.fulfill({
				json: { state: "sent", messageId: "sent-3", subject: "Re: Files to review", to: "sophie@example.com" },
			}),
		);
		await page.route("**/api/agent/approvals", (route) =>
			route.fulfill({
				json: {
					approvalId: "approval-1",
					snapshot: {
						from: "admin@example.com",
						to: "sophie@example.com",
						cc: null,
						bcc: null,
						subject: "Re: Files to review",
						text: "Hi Sophie, I'll review the files today.",
						html: null,
						scheduledAt: null,
						attachments: [],
					},
				},
			}),
		);
		await page.route("**/api/agent/approvals/approval-1/confirm", (route) => {
			sent = true;
			return route.fulfill({ json: { status: "sent", messageId: "sent-3", scheduled: false } });
		});
	});
	const card = panel.getByRole("region", { name: "Reply draft" });
	await card.getByRole("button", { name: "Approve to send" }).click();
	await page.getByRole("button", { name: "Confirm and send" }).click();
	await expect(card.getByText("Sent", { exact: true })).toBeVisible();
	await expect(card.getByRole("button")).toHaveCount(0);
	await expect(card.getByText("Preview unavailable")).toHaveCount(0);
});
