import { expect, test, type APIRequestContext } from "@playwright/test";
import { createSignedInAccount } from "./support/auto-read";
import { STORAGE_STATE } from "./support/constants";
import { apiContext, uniqueToken, waitForMessage } from "./support/helpers";
import { sampleMessage, startFakeImap } from "../tests/support/fake-imap.mjs";

// Servers the user names (hardening from #149): failed sign-ins are counted per user and per user and server, past
// the limit the routes answer 429 with Retry-After and nothing connects, while any number of successful steps (as
// measuring a big folder takes) is never limited. A message above the size limit is skipped and named, not a reason
// for the whole batch to fail. The fake IMAP server stands in for the provider; each test has its own account, so one
// test's failures never count against another.

const USER = "user@example.test";
const PASSWORD = "app-password";
const MB = 1024 * 1024;

type FakeImap = Awaited<ReturnType<typeof startFakeImap>>;

function login(fake: FakeImap, password = PASSWORD) {
	return { host: fake.host, port: fake.port, secure: false, username: USER, password };
}

/** The sign-ins the fake server saw (`LOGIN` or `AUTHENTICATE`). */
function signIns(fake: FakeImap): number {
	return fake.commands.filter((entry: { line: string }) => /\b(LOGIN|AUTHENTICATE)\b/i.test(entry.line)).length;
}

async function newUser(label: string) {
	const admin = await apiContext(STORAGE_STATE);
	try {
		return await createSignedInAccount(admin, uniqueToken(label));
	} finally {
		await admin.dispose();
	}
}

test("repeated wrong passwords are refused with 429 and Retry-After, before anything connects", async () => {
	test.setTimeout(90_000);
	const { api } = await newUser("lim");
	const fake = await startFakeImap({ authPlain: true });
	const other = await startFakeImap({ authPlain: true });
	try {
		// Five failures at one server are allowed (answered 502 with the server's refusal).
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const response = await api.post("/api/import/imap/folders", { data: login(fake, `wrong-${attempt}`) });
			expect(response.status(), await response.text()).toBe(502);
		}
		expect(signIns(fake)).toBe(5);

		const refused = await api.post("/api/import/imap/folders", { data: login(fake, "wrong-5") });
		expect(refused.status()).toBe(429);
		const retryAfter = Number(refused.headers()["retry-after"]);
		expect(retryAfter).toBeGreaterThan(0);
		expect(retryAfter).toBeLessThanOrEqual(600);
		const body = (await refused.json()) as { error: string; code: string; retryAfterSeconds: number };
		expect(body.code).toBe("RATE_LIMITED");
		expect(body.error).toMatch(/Too many failed sign-ins/);
		expect(body.retryAfterSeconds).toBe(retryAfter);
		// Even the right password is refused for now, and no routes that sign in to that server get through.
		for (const path of ["/api/import/imap/folders", "/api/import/account/plan"]) {
			const response = await api.post(path, { data: login(fake) });
			expect(response.status(), path).toBe(429);
		}
		const sizes = await api.post("/api/import/account/sizes", { data: { ...login(fake), folder: "INBOX" } });
		expect(sizes.status()).toBe(429);
		expect(signIns(fake)).toBe(5);

		// Another server is its own count: it signs in, and what is left of the user's budget is still there.
		const fine = await api.post("/api/import/imap/folders", { data: login(other) });
		expect(fine.status(), await fine.text()).toBe(200);
		expect(signIns(other)).toBe(1);
	} finally {
		await api.dispose();
		await fake.close();
		await other.close();
	}
});

test("the user's limit counts failures at every server together", async () => {
	test.setTimeout(120_000);
	const { api } = await newUser("lim");
	const servers = await Promise.all(Array.from({ length: 6 }, () => startFakeImap({ authPlain: true })));
	try {
		// Two failures at each of five servers is ten failures, under no per-server limit.
		for (const fake of servers.slice(0, 5))
			for (let attempt = 0; attempt < 2; attempt += 1) {
				const response = await api.post("/api/import/imap/folders", { data: login(fake, "wrong") });
				expect(response.status()).toBe(502);
			}
		const refused = await api.post("/api/import/imap/folders", { data: login(servers[5]) });
		expect(refused.status()).toBe(429);
		expect(signIns(servers[5])).toBe(0);
	} finally {
		await api.dispose();
		await Promise.all(servers.map((fake) => fake.close()));
	}
});

test("successful sign-ins are never limited, however many steps measuring a folder takes", async () => {
	test.setTimeout(120_000);
	const { api } = await newUser("lim");
	const fake = await startFakeImap({
		authPlain: true,
		folders: { INBOX: Array.from({ length: 3 }, (_, index) => sampleMessage(index + 1)) },
	});
	try {
		for (let step = 0; step < 25; step += 1) {
			const response = await api.post("/api/import/account/sizes", { data: { ...login(fake), folder: "INBOX" } });
			expect(response.status(), `step ${step}: ${await response.text()}`).toBe(200);
		}
		expect(signIns(fake)).toBe(25);
		// A wrong password afterwards still has its whole budget.
		const wrong = await api.post("/api/import/account/plan", { data: login(fake, "wrong") });
		expect(wrong.status()).toBe(502);
	} finally {
		await api.dispose();
		await fake.close();
	}
});

async function importedFrom(api: APIRequestContext, jobId: string) {
	let job: { status: string; imported: number; skipped: number; errors: string[] } | undefined;
	await expect
		.poll(
			async () => {
				const { jobs } = (await (await api.get("/api/import/jobs", { timeout: 60_000 })).json()) as {
					jobs: { id: string; status: string; imported: number; skipped: number; errors: string[] }[];
				};
				job = jobs.find((entry) => entry.id === jobId);
				return job?.status;
			},
			{ timeout: 90_000, intervals: [1000] },
		)
		.toMatch(/completed|failed/);
	return job!;
}

test("a message above the size limit is skipped and named, and the rest of the job is imported", async () => {
	test.setTimeout(120_000);
	const { api, mailboxId } = await newUser("big");
	const token = uniqueToken("big");
	const fake = await startFakeImap({
		authPlain: true,
		folders: {
			INBOX: [
				sampleMessage(1, { subject: `${token} before` }),
				// The server says 80 MB (RFC822.SIZE): over the limit on Workers and on Node, so it is never fetched.
				{ raw: sampleMessage(2, { subject: `${token} huge` }), size: 80 * MB },
				sampleMessage(3, { subject: `${token} after` }),
			],
		},
	});
	let jobId = "";
	try {
		const created = await api.post("/api/import/jobs", { data: { mailboxId, ...login(fake), folder: "INBOX" } });
		expect(created.status(), await created.text()).toBe(201);
		jobId = ((await created.json()) as { job: { id: string } }).job.id;
		const job = await importedFrom(api, jobId);
		expect(job.status).toBe("completed");
		expect([job.imported, job.skipped]).toEqual([2, 1]);
		expect(job.errors.join("\n")).toMatch(/INBOX: skipped message 2, 80 MB is over the \d+ MB limit/);
		await waitForMessage(api, `${token} before`);
		await waitForMessage(api, `${token} after`);
		// Its body was never asked for: the UID FETCH of bodies names the other two only.
		const fetchedUids = fake.commands
			.map((entry: { line: string }) => /UID FETCH ([\d,]+) \(.*BODY\.PEEK\[\]/i.exec(entry.line)?.[1])
			.filter((uids: string | undefined): uids is string => !!uids)
			.flatMap((uids: string) => uids.split(","));
		expect(fetchedUids.sort()).toEqual(["1", "3"]);
	} finally {
		if (jobId) await api.delete(`/api/import/jobs/${jobId}`);
		await api.dispose();
		await fake.close();
	}
});

test("the direct import route skips an oversized message and says so", async () => {
	test.setTimeout(60_000);
	const { api, mailboxId } = await newUser("big");
	const token = uniqueToken("direct");
	const fake = await startFakeImap({
		authPlain: true,
		folders: {
			INBOX: [
				sampleMessage(1, { subject: `${token} small` }),
				{ raw: sampleMessage(2, { subject: `${token} huge` }), size: 200 * MB },
			],
		},
	});
	try {
		const response = await api.post("/api/import/imap", {
			data: { mailboxId, ...login(fake), folder: "INBOX", destination: "system:inbox" },
		});
		expect(response.status(), await response.text()).toBe(200);
		const body = (await response.json()) as { imported: number; skipped: number; errors: string[] };
		expect([body.imported, body.skipped]).toEqual([1, 1]);
		expect(body.errors.join("\n")).toMatch(/skipped message 2, 200 MB is over the \d+ MB limit/);
	} finally {
		await api.dispose();
		await fake.close();
	}
});
