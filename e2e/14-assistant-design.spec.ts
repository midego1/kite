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
						"Hi Sophie,\n\nThanks for sharing, this looks great! I'll review the files today and send you my feedback.\n\nBest,\nMichiel",
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
