import { expect, test, type APIRequestContext } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, uniqueToken } from "./support/helpers";

type Invocation = [string, Record<string, unknown>, string];

const CORE = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];
const VACATION = "urn:ietf:params:jmap:vacationresponse";

let admin: APIRequestContext;
let client: APIRequestContext;
let keyId: string;
let headers: Record<string, string>;
let accountId: string;

test.beforeAll(async () => {
	admin = await apiContext(STORAGE_STATE);
	client = await apiContext();
	const { mailboxes } = (await (await admin.get("/api/mailboxes")).json()) as {
		mailboxes: { id: string; localPart: string; hostname: string }[];
	};
	const support = mailboxes.find((item) => `${item.localPart}@${item.hostname}` === SUPPORT_ADDRESS);
	expect(support, SUPPORT_ADDRESS).toBeDefined();
	const created = await admin.post("/api/api-keys", {
		data: { name: uniqueToken("jmap"), scopes: ["jmap"], mailboxIds: [support!.id] },
	});
	expect(created.status(), await created.text()).toBe(200);
	const { id, key } = (await created.json()) as { id: string; key: string };
	keyId = id;
	headers = { Authorization: `Bearer ${key}` };
	const session = await client.get("/jmap/session", { headers });
	expect(session.status(), await session.text()).toBe(200);
	accountId = ((await session.json()) as { primaryAccounts: Record<string, string> }).primaryAccounts[CORE[1]];
});

test.afterAll(async () => {
	await admin.delete(`/api/api-keys?id=${encodeURIComponent(keyId)}`);
	await client.dispose();
	await admin.dispose();
});

async function call(using: string[], methodCalls: unknown[]) {
	return client.post("/jmap/api", { headers, data: { using, methodCalls } });
}

test("a client that lists vacationresponse in using still syncs, and that extension's methods are unknown (upstream #155)", async () => {
	const response = await call(
		[...CORE, VACATION],
		[
			["Mailbox/get", { accountId, ids: null }, "m"],
			["VacationResponse/get", { accountId }, "v"],
		],
	);
	expect(response.status(), await response.text()).toBe(200);
	const { methodResponses } = (await response.json()) as { methodResponses: Invocation[] };
	expect(methodResponses.map(([name, , callId]) => [name, callId])).toEqual([
		["Mailbox/get", "m"],
		["error", "v"],
	]);
	expect((methodResponses[0][1].list as unknown[]).length).toBeGreaterThan(0);
	expect(methodResponses[1][1]).toEqual({ type: "unknownMethod" });
});

test("a capability outside the IETF JMAP namespace is still refused (upstream #155)", async () => {
	const response = await call([...CORE, "https://example.com/apis/foobar"], [["Core/echo", {}, "e"]]);
	expect(response.status()).toBe(400);
	expect(await response.json()).toMatchObject({ type: "urn:ietf:params:jmap:error:unknownCapability" });
});
