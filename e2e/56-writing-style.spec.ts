import { expect, test, type APIRequestContext, type Browser } from "@playwright/test";
import { DOMAIN, STORAGE_STATE } from "./support/constants";
import { useFakeProvider } from "./support/agent";
import { createSignedInAccount, okJson, selectMailbox } from "./support/auto-read";
import { chatRequests, sendChat, systemPrompt } from "./support/chat";
import { startFakeModel } from "./support/fake-model";
import type { FakeModel } from "./support/fake-model-types";
import { apiContext, uniqueToken } from "./support/helpers";

let api: APIRequestContext;
let fake: FakeModel;
let restore: () => Promise<void>;

test.beforeAll(async () => {
	api = await apiContext(STORAGE_STATE);
	fake = await startFakeModel();
	restore = await useFakeProvider(api, fake);
});

test.afterAll(async () => {
	await restore?.();
	await fake?.close();
	await api?.dispose();
});

test.beforeEach(() => fake.clearRequests());

const STYLE_HEADING = "Writing style of the person you write for";

type Account = Awaited<ReturnType<typeof createSignedInAccount>> & { address: string };
type Profile = { mailboxId: string; sampleCount: number; description: string | null; backfillPending: boolean };

async function newAccount(prefix: string): Promise<Account> {
	const username = `${prefix}${uniqueToken("")}`;
	const account = await createSignedInAccount(api, username);
	return { ...account, address: `${username}@${DOMAIN}` };
}

/** One message sent the way the composer sends it: `/api/send` with the session. */
async function composerSend(account: Account, index: number, aiAssisted = false) {
	const html = `<div>Hi Sam,</div><div><br></div><div>Thanks for the update on plan ${index}. Can you send me the latest figures before Friday so I can review them with the team?</div><div><br></div><div>Cheers,</div>`;
	await okJson(
		await account.api.post("/api/send", {
			data: {
				from: account.address,
				to: "sam@partner.test",
				subject: `Plan ${index}`,
				html,
				text: "Hi Sam",
				mailboxId: account.mailboxId,
				...(aiAssisted ? { aiAssisted: true } : {}),
			},
		}),
	);
}

async function profileOf(account: Account): Promise<Profile | undefined> {
	const { profiles } = await okJson<{ profiles: Profile[] }>(
		await account.api.get("/api/settings/assistant/writing-style"),
	);
	return profiles.find((profile) => profile.mailboxId === account.mailboxId);
}

async function composeSystem(account: Account, data: Record<string, unknown>): Promise<string> {
	fake.clearRequests();
	const response = await account.api.post("/api/agent/compose", { data: { mailboxId: account.mailboxId, ...data } });
	expect(response.ok(), await response.text()).toBe(true);
	await response.text();
	const [request] = fake.requests().filter((entry) => entry.kind === "compose");
	return systemPrompt(request);
}

async function openSettings(browser: Browser, account: Account) {
	const context = await browser.newContext({ storageState: await account.api.storageState() });
	const page = await context.newPage();
	await selectMailbox(page, account.mailboxId);
	await page.goto("/inbox");
	const toggle = page.getByRole("button", { name: /^(Open|Close) email assistant$/ });
	if ((await toggle.getAttribute("aria-label")) === "Open email assistant") await toggle.click({ timeout: 45_000 });
	const panel = page.locator("#email-assistant-panel");
	await panel.getByRole("button", { name: "Assistant settings" }).click();
	const section = panel.getByRole("region", { name: "Writing style" });
	await expect(section).toBeVisible();
	return { context, page, section };
}

test.describe("writing style profile", () => {
	test("off by default; opted in it learns from composer sends, tells the AI, skips AI-assisted mail and resets", async ({
		browser,
	}) => {
		const account = await newAccount("wsp");
		const { context, page, section } = await openSettings(browser, account);
		try {
			const toggle = section.getByRole("switch", { name: "Learn my writing style from mail I send" });
			await expect(toggle).not.toBeChecked();
			await composerSend(account, 0);
			expect(await profileOf(account)).toBeUndefined();

			await toggle.click();
			await page.getByRole("button", { name: "Only from now on" }).click();
			await expect(toggle).toBeChecked();
			for (let index = 1; index <= 9; index++) await composerSend(account, index);
			expect((await profileOf(account))?.description).toBeNull();
			expect(await composeSystem(account, { mode: "write", instruction: "Say hi" })).not.toContain(STYLE_HEADING);

			await composerSend(account, 10);
			await composerSend(account, 11, true);
			const profile = await profileOf(account);
			expect(profile?.sampleCount).toBe(10);
			expect(profile?.description).toMatch(/Opens with "hi \{name\}," and closes with "cheers,"\./);

			await page.reload();
			await page.locator("#email-assistant-panel").getByRole("button", { name: "Assistant settings" }).click();
			await expect(section.getByText("Learnt from 10 sent messages.")).toBeVisible();
			await expect(section.getByText("This is what Kite tells the AI:")).toBeVisible();
			await expect(section.locator("blockquote")).toHaveText(profile!.description!);

			const system = await composeSystem(account, { mode: "write", instruction: "Say hi" });
			expect(system).toContain(
				`${STYLE_HEADING} (a statistical hint; the instructions above and the user's own request take priority):\n${profile!.description}`,
			);
			expect(
				await composeSystem(account, { mode: "rewrite", action: "grammar", text: "Helo Sam, see you." }),
			).not.toContain(STYLE_HEADING);

			fake.clearRequests();
			fake.scriptChat({ content: "Done." });
			await sendChat(account.api, account.mailboxId, "Draft a reply to Sam");
			expect(systemPrompt(chatRequests(fake)[0])).toContain(
				`When you write a draft body, match this style: ${profile!.description}`,
			);

			await section.getByRole("button", { name: `Reset writing style for ${account.address}` }).click();
			await expect(section.getByText("Kite needs 10 sent messages before it uses your style.")).toBeVisible();
			expect((await profileOf(account))?.sampleCount).toBe(0);
			expect(await composeSystem(account, { mode: "write", instruction: "Say hi" })).not.toContain(STYLE_HEADING);
		} finally {
			await context.close();
			await account.api.dispose();
		}
	});

	test("turning it on can learn from earlier composer sends; turning it off deletes every profile", async ({
		browser,
	}) => {
		const account = await newAccount("wsb");
		for (let index = 0; index < 11; index++) await composerSend(account, index);
		await composerSend(account, 99, true);
		const { context, page, section } = await openSettings(browser, account);
		try {
			const toggle = section.getByRole("switch", { name: "Learn my writing style from mail I send" });
			await toggle.click();
			await page.getByRole("button", { name: "Learn from sent mail" }).click();
			await expect.poll(async () => (await profileOf(account))?.sampleCount, { timeout: 30_000 }).toBe(11);
			await expect.poll(async () => (await profileOf(account))?.backfillPending).toBe(false);

			await toggle.click();
			await page.getByRole("button", { name: "Turn off and delete" }).click();
			await expect(toggle).not.toBeChecked();
			const settings = await okJson<{ writingStyle: { enabled: boolean } }>(
				await account.api.get("/api/settings/assistant"),
			);
			expect(settings.writingStyle.enabled).toBe(false);
			await okJson(await account.api.patch("/api/settings/assistant", { data: { writingStyle: { enabled: true } } }));
			expect((await profileOf(account))?.sampleCount ?? 0).toBe(0);
			const again = await account.api.post("/api/settings/assistant/writing-style/backfill", {
				data: { mailboxId: "mbx_missing" },
			});
			expect(again.status()).toBe(404);
		} finally {
			await context.close();
			await account.api.dispose();
		}
	});
});
