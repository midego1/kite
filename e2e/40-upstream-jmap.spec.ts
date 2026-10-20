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

test("Email/get and Thread/get answer 200 ids with repeats once each (upstream #157)", async () => {
	const queried = await call(CORE, [["Email/query", { accountId, limit: 100 }, "q"]]);
	expect(queried.status(), await queried.text()).toBe(200);
	const stored = ((await queried.json()) as { methodResponses: Invocation[] }).methodResponses[0][1].ids as string[];
	expect(stored.length).toBeGreaterThan(1);
	const missing = Array.from({ length: 198 - stored.length }, (_, index) => `msg_missing_${index}`);
	// The repeats sit after the padding, so they fall into a later batch than the first copy.
	const requested = [...stored, ...missing, stored[0], stored[1]];
	expect(requested).toHaveLength(200);

	const got = await call(CORE, [["Email/get", { accountId, ids: requested, properties: ["id", "threadId"] }, "g"]]);
	expect(got.status(), await got.text()).toBe(200);
	const [[name, email]] = ((await got.json()) as { methodResponses: Invocation[] }).methodResponses;
	expect(name, JSON.stringify(email)).toBe("Email/get");
	const list = email.list as { id: string; threadId: string }[];
	expect(list.map((item) => item.id).sort()).toEqual([...stored].sort());
	expect(email.notFound).toEqual(missing);

	const threadIds = [...new Set(list.map((item) => item.threadId))];
	const threadRequest = [...threadIds, ...missing.slice(0, 150 - threadIds.length), threadIds[0]];
	const threads = await call(CORE, [["Thread/get", { accountId, ids: threadRequest }, "t"]]);
	expect(threads.status(), await threads.text()).toBe(200);
	const [[threadName, thread]] = ((await threads.json()) as { methodResponses: Invocation[] }).methodResponses;
	expect(threadName, JSON.stringify(thread)).toBe("Thread/get");
	const groups = thread.list as { id: string; emailIds: string[] }[];
	expect(groups.map((group) => group.id).sort()).toEqual([...threadIds].sort());
	const emailIds = groups.flatMap((group) => group.emailIds);
	expect(new Set(emailIds).size).toBe(emailIds.length);
});

test("Email/set accepts RFC 6901-escaped patch keys for a move and a flag (upstream #162)", async () => {
	const listed = await call(CORE, [["Mailbox/get", { accountId, ids: null, properties: ["id", "role"] }, "m"]]);
	expect(listed.status(), await listed.text()).toBe(200);
	const boxes = ((await listed.json()) as { methodResponses: Invocation[] }).methodResponses[0][1].list as {
		id: string;
		role: string | null;
	}[];
	const drafts = boxes.find((box) => box.role === "drafts")!.id;
	const trash = boxes.find((box) => box.role === "trash")!.id;
	expect(drafts).toContain("~");
	expect(trash).toContain("~");
	const escape = (token: string) => token.replace(/~/g, "~0").replace(/\//g, "~1");

	const created = await call(CORE, [
		[
			"Email/set",
			{
				accountId,
				create: {
					d: {
						mailboxIds: { [drafts]: true },
						from: [{ email: SUPPORT_ADDRESS }],
						subject: uniqueToken("pointer"),
						bodyValues: { t: { value: "Escaped patch keys" } },
						textBody: [{ partId: "t", type: "text/plain" }],
					},
				},
			},
			"c",
		],
	]);
	expect(created.status(), await created.text()).toBe(200);
	const createResult = ((await created.json()) as { methodResponses: Invocation[] }).methodResponses[0][1];
	const id = (createResult.created as Record<string, { id: string }> | undefined)?.d?.id;
	expect(id, JSON.stringify(createResult)).toBeDefined();

	try {
		const moved = await call(CORE, [
			[
				"Email/set",
				{
					accountId,
					update: {
						[id!]: {
							[`mailboxIds/${escape(drafts)}`]: null,
							[`mailboxIds/${escape(trash)}`]: true,
							"keywords/$flagged": true,
						},
					},
				},
				"u",
			],
			["Email/get", { accountId, ids: [id], properties: ["mailboxIds", "keywords"] }, "g"],
		]);
		expect(moved.status(), await moved.text()).toBe(200);
		const [[, update], [, got]] = ((await moved.json()) as { methodResponses: Invocation[] }).methodResponses;
		expect(update.notUpdated ?? {}, JSON.stringify(update)).toEqual({});
		expect(Object.keys(update.updated as Record<string, unknown>)).toEqual([id]);
		const [email] = got.list as { mailboxIds: Record<string, boolean>; keywords: Record<string, boolean> }[];
		expect(email.mailboxIds).toEqual({ [trash]: true });
		expect(email.keywords.$flagged).toBe(true);
	} finally {
		await call(CORE, [["Email/set", { accountId, destroy: [id] }, "x"]]);
	}
});

test("a capability outside the IETF JMAP namespace is still refused (upstream #155)", async () => {
	const response = await call([...CORE, "https://example.com/apis/foobar"], [["Core/echo", {}, "e"]]);
	expect(response.status()).toBe(400);
	expect(await response.json()).toMatchObject({ type: "urn:ietf:params:jmap:error:unknownCapability" });
});
