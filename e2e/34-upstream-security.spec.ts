import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { DOMAIN, STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, apiSignIn, deliverInbound, signIn, uniqueToken } from "./support/helpers";

const PASSWORD = "upstream-security-password-123";
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);

type Detail = { attachments: { id: string; filename: string }[] };
type Account = { id: string; address: string };

async function json<T>(response: APIResponse): Promise<T> {
	expect(response.ok(), `${response.url()} -> ${response.status()} ${await response.text()}`).toBe(true);
	return (await response.json()) as T;
}

async function exampleDomainId(api: APIRequestContext): Promise<string> {
	const { domains } = await json<{ domains: { id: string; hostname: string }[] }>(await api.get("/api/domains"));
	const domain = domains.find((item) => item.hostname === DOMAIN);
	expect(domain).toBeDefined();
	return domain!.id;
}

async function createAccount(
	admin: APIRequestContext,
	domainId: string,
	username: string,
	permissions?: { canManageMailboxes: boolean; canManageDomains: boolean },
): Promise<Account> {
	const role = permissions ? "admin" : "user";
	const { account } = await json<{ account: { id: string } }>(
		await admin.post("/api/accounts", {
			data: { username, domainId, password: PASSWORD, role, useAllDomains: true },
		}),
	);
	if (permissions) {
		await json(
			await admin.patch(`/api/accounts/${account.id}`, {
				data: { name: username, role, disabled: false, ...permissions },
			}),
		);
	}
	return { id: account.id, address: `${username}@${DOMAIN}` };
}

test("attachments that can run script are never served inline", async () => {
	const api = await apiContext(STORAGE_STATE);
	const subject = `Inline attachment types ${uniqueToken("att")}`;
	const message = await deliverInbound(api, {
		from: "Sender <sender@outside.test>",
		to: SUPPORT_ADDRESS,
		subject,
		text: "Attachments with types a browser may run.",
		attachments: [
			{
				filename: "logo.svg",
				contentType: "image/svg+xml",
				disposition: "inline",
				content: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
			},
			{
				filename: "feed.xml",
				contentType: "application/xml",
				content: '<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>',
			},
			{ filename: "pixel.png", contentType: "image/png", disposition: "inline", content: PNG },
			{ filename: "notes.txt", contentType: "text/plain; charset=utf-8", content: "Plain notes." },
		],
	});
	const { attachments } = await json<Detail>(await api.get(`/api/messages/${message.id}`));
	const fetchAttachment = async (filename: string, query = "") => {
		const attachment = attachments.find((item) => item.filename === filename);
		expect(attachment, filename).toBeDefined();
		const response = await api.get(`/api/messages/${message.id}/attachments/${attachment!.id}${query}`);
		expect(response.status()).toBe(200);
		return { type: response.headers()["content-type"], disposition: response.headers()["content-disposition"] };
	};

	await test.step("an SVG the sender marked inline downloads", async () => {
		const svg = await fetchAttachment("logo.svg");
		expect(svg.disposition).toMatch(/^attachment;/);
		expect(svg.type).toBe("image/svg+xml");
		expect((await fetchAttachment("logo.svg", "?preview=1")).disposition).toMatch(/^attachment;/);
	});

	await test.step("XML is not previewed inline", async () => {
		expect((await fetchAttachment("feed.xml", "?preview=1")).disposition).toMatch(/^attachment;/);
	});

	await test.step("types that cannot run script still preview inline", async () => {
		const png = await fetchAttachment("pixel.png");
		expect(png).toEqual({ type: "image/png", disposition: 'inline; filename="pixel.png"' });
		const text = await fetchAttachment("notes.txt", "?preview=1");
		expect(text.disposition).toMatch(/^inline;/);
		expect(text.type).toMatch(/^text\/plain\b/);
		expect((await fetchAttachment("pixel.png", "?download=1")).disposition).toMatch(/^attachment;/);
	});

	await api.dispose();
});

test("domain routing needs domain-management permission, not mailbox management", async ({ browser }) => {
	const token = uniqueToken("dr");
	const owner = await apiContext(STORAGE_STATE);
	const domainId = await exampleDomainId(owner);
	const mailboxAdmin = await createAccount(owner, domainId, `mbadmin${token}`, {
		canManageMailboxes: true,
		canManageDomains: false,
	});
	const domainAdmin = await createAccount(owner, domainId, `dnadmin${token}`, {
		canManageMailboxes: false,
		canManageDomains: true,
	});
	const rule = {
		domainId,
		matchField: "sender",
		matchOperator: "exact",
		matchValue: `blocked${token}@outside.test`,
		action: "reject",
	};

	await test.step("an admin who only manages mailboxes cannot read or change domain rules", async () => {
		const api = await apiSignIn(mailboxAdmin.address, PASSWORD);
		expect((await api.get(`/api/routing-rules/domain?domainId=${domainId}`)).status()).toBe(403);
		expect((await api.get("/api/routing-rules/domain?list=true")).status()).toBe(403);
		expect((await api.post("/api/routing-rules/domain", { data: rule })).status()).toBe(403);
		await api.dispose();
	});

	await test.step("an admin granted domain management manages the primary admin's domain rules", async () => {
		const api = await apiSignIn(domainAdmin.address, PASSWORD);
		const { domains } = await json<{ domains: { id: string }[] }>(await api.get("/api/routing-rules/domain?list=true"));
		expect(domains.map((domain) => domain.id)).toContain(domainId);
		await json(await api.get(`/api/routing-rules/domain?domainId=${domainId}`));
		const created = await json<{ id: string }>(await api.post("/api/routing-rules/domain", { data: rule }));
		await json(await api.delete(`/api/routing-rules/domain/${created.id}`));
		await api.dispose();
	});

	await test.step("only the domain admin sees the routing editor", async () => {
		for (const [account, canManage] of [
			[mailboxAdmin, false],
			[domainAdmin, true],
		] as const) {
			const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
			const page = await context.newPage();
			await signIn(page, account.address, PASSWORD);
			await page.goto("/settings/rules");
			const notice = page.getByText("Domain routing is managed by an admin.", { exact: false });
			const addRoute = page.getByRole("button", { name: "Add route" });
			if (canManage) {
				await expect(addRoute).toBeEnabled();
				await expect(notice).toHaveCount(0);
			} else {
				await expect(notice).toBeVisible();
				await expect(addRoute).toBeDisabled();
			}
			await context.close();
		}
	});

	await owner.dispose();
});

test("the mailbox rule endpoint cannot change a domain rule that delivers to that mailbox", async () => {
	const token = uniqueToken("mr");
	const owner = await apiContext(STORAGE_STATE);
	const domainId = await exampleDomainId(owner);
	const account = await createAccount(owner, domainId, `rules${token}`);
	const user = await apiSignIn(account.address, PASSWORD);
	const { mailboxes } = await json<{ mailboxes: { id: string; localPart: string }[] }>(
		await user.get("/api/mailboxes"),
	);
	const mailbox = mailboxes.find((item) => item.localPart === `rules${token}`);
	expect(mailbox).toBeDefined();

	const matchValue = `catch${token}@${DOMAIN}`;
	const created = await json<{ id: string }>(
		await owner.post("/api/routing-rules/domain", {
			data: {
				domainId,
				matchField: "recipient",
				matchOperator: "exact",
				matchValue,
				action: "store",
				mailboxId: mailbox!.id,
			},
		}),
	);

	const edit = { mailboxId: mailbox!.id, matchField: "email", matchValue: "*", destination: "trash" };
	expect((await user.patch(`/api/routing-rules/${created.id}`, { data: edit })).status()).toBe(404);
	expect((await user.delete(`/api/routing-rules/${created.id}`)).status()).toBe(404);

	const { rules } = await json<{ rules: { id: string; matchValue: string; action: string }[] }>(
		await owner.get(`/api/routing-rules/domain?domainId=${domainId}`),
	);
	expect(rules.find((item) => item.id === created.id)).toMatchObject({ matchValue, action: "store" });
	await json(await owner.delete(`/api/routing-rules/domain/${created.id}`));

	await user.dispose();
	await owner.dispose();
});
