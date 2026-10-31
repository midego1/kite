/**
 * Kills the admin attachment storage job part way and checks that it converges (docs/specs/attachments-once.md §8
 * step 5), against a running dev server:
 *
 *   ATTACHMENT_STORAGE_TEST_HOOKS=1 npm run dev && npm run db:seed   # in another shell
 *   node scripts/attachment-storage-check.mjs
 *
 * It delivers a few messages with base64 attachments through the local email handler, then starts materialize and
 * reclaim with `testCrashAfter`, which makes the first batch die after that many files without writing anything, as a
 * killed isolate would: the lease stays held and the cursor where it was. The queue delivers the message again, it
 * waits for the lease to run out (about a minute) and the job finishes. Every file must still download byte-exact,
 * the counts must land exactly where a clean run puts them and no referenced object may be missing.
 * BASE_URL overrides http://localhost:3000; ADMIN_EMAIL and ADMIN_PASSWORD override the seeded demo admin.
 */

import { createHash, randomBytes } from "node:crypto";

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const ADMIN = {
	email: process.env.ADMIN_EMAIL ?? "admin@example.com",
	password: process.env.ADMIN_PASSWORD ?? "demo-password-change-me",
};
const MESSAGES = 4;
const FILES_PER_MESSAGE = 2;
const JOB_TIMEOUT_MS = 4 * 60_000;

let passed = 0;
let failed = 0;
let cookie = "";

function check(name, ok, detail) {
	if (ok) {
		passed += 1;
		console.log(`  ok   ${name}`);
	} else {
		failed += 1;
		console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function api(path, init = {}) {
	const response = await fetch(`${BASE}${path}`, {
		...init,
		headers: { Cookie: cookie, Origin: BASE, ...(init.headers ?? {}) },
	});
	return response;
}

async function json(path, init) {
	const response = await api(path, init);
	const body = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path}: ${response.status} ${JSON.stringify(body)}`);
	return body;
}

async function signIn() {
	const response = await fetch(`${BASE}/api/auth/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: BASE },
		body: JSON.stringify(ADMIN),
	});
	if (!response.ok) throw new Error(`login failed (${response.status}); run npm run db:seed first`);
	cookie = (response.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
}

/** A multipart/mixed message with base64 attachments in 76-column lines, which reclaim can serve from the raw. */
function buildMime({ from, to, subject, files }) {
	const boundary = `kite-storage-check-${randomBytes(6).toString("hex")}`;
	const lines = [
		`From: ${from}`,
		`To: ${to}`,
		`Subject: ${subject}`,
		`Message-ID: <${randomBytes(8).toString("hex")}@storage-check.test>`,
		`Date: ${new Date().toUTCString()}`,
		"MIME-Version: 1.0",
		`Content-Type: multipart/mixed; boundary="${boundary}"`,
		"",
		`--${boundary}`,
		"Content-Type: text/plain; charset=utf-8",
		"",
		"Files for the storage check.",
	];
	for (const file of files)
		lines.push(
			`--${boundary}`,
			`Content-Type: application/octet-stream; name="${file.name}"`,
			`Content-Disposition: attachment; filename="${file.name}"`,
			"Content-Transfer-Encoding: base64",
			"",
			...(file.bytes.toString("base64").match(/.{1,76}/g) ?? []),
		);
	lines.push(`--${boundary}--`, "");
	return lines.join("\r\n");
}

async function deliver(to, token, index) {
	const files = Array.from({ length: FILES_PER_MESSAGE }, (_, file) => ({
		name: `file-${index}-${file}.bin`,
		bytes: randomBytes(24 * 1024 + index * 100 + file),
	}));
	const subject = `Storage check ${token} ${index}`;
	const from = "storage-check@outside.test";
	const query = new URLSearchParams({ from, to });
	const response = await fetch(`${BASE}/cdn-cgi/handler/email?${query}`, {
		method: "POST",
		headers: { "Content-Type": "message/rfc822" },
		body: buildMime({ from, to, subject, files }),
	});
	if (response.status !== 200) throw new Error(`delivery failed (${response.status})`);
	return { subject, files };
}

async function findMessage(subject) {
	for (let attempt = 0; attempt < 90; attempt++) {
		const { messages } = await json(`/api/messages?${new URLSearchParams({ q: subject, limit: "5" })}`);
		const found = messages.find((message) => message.subject === subject);
		if (found) return found;
		await sleep(500);
	}
	throw new Error(`message "${subject}" was never stored`);
}

const report = () => json("/api/admin/attachment-storage");

async function startJob(action, testCrashAfter) {
	const { job } = await json("/api/admin/attachment-storage", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ action, ...(testCrashAfter ? { testCrashAfter } : {}) }),
	});
	return job;
}

async function waitForJob(jobId) {
	const until = Date.now() + JOB_TIMEOUT_MS;
	while (Date.now() < until) {
		const { job } = await report();
		if (job?.id === jobId && job.status !== "running") return job;
		await sleep(1000);
	}
	throw new Error(`job ${jobId} did not finish within ${JOB_TIMEOUT_MS / 1000} s`);
}

/** Every delivered file downloads with the bytes that were sent. */
async function filesIntact(delivered) {
	for (const { message, files } of delivered) {
		const { attachments } = await json(`/api/messages/${message.id}`);
		for (const file of files) {
			const attachment = attachments.find((entry) => entry.filename === file.name);
			if (!attachment) return false;
			const response = await api(`/api/messages/${message.id}/attachments/${attachment.id}?download=1`);
			if (response.status !== 200 || sha256(Buffer.from(await response.arrayBuffer())) !== sha256(file.bytes))
				return false;
		}
	}
	return true;
}

/** Starts a job with the crash hook and checks that the first batch died part way before it converged. */
async function crashAndConverge(action, crashAfter, before) {
	const job = await startJob(action, crashAfter);
	let died = false;
	for (let attempt = 0; attempt < 20 && !died; attempt++) {
		await sleep(500);
		const current = await report();
		const moved = action === "materialize" ? before.raw.rows - current.raw.rows : current.raw.rows - before.raw.rows;
		// Materialize counts files; reclaim counts messages, each with at least one file.
		const expected = action === "materialize" ? moved === crashAfter : moved >= crashAfter;
		died = current.job?.status === "running" && current.job.done === 0 && expected;
	}
	check(`${action}: the first batch died after ${crashAfter} items without recording them`, died);
	const finished = await waitForJob(job.id);
	check(`${action}: the job converged after the killed batch`, finished.status === "completed", finished);
	return finished;
}

async function main() {
	await signIn();
	const { mailboxes } = await json("/api/mailboxes");
	const mailbox = mailboxes.find((entry) => !entry.disabled) ?? mailboxes[0];
	if (!mailbox) throw new Error("no mailbox; run npm run db:seed first");
	const address = `${mailbox.localPart}@${mailbox.hostname}`;
	const token = randomBytes(4).toString("hex");

	console.log(`\nDelivering ${MESSAGES} messages with ${FILES_PER_MESSAGE} files each to ${address}`);
	const delivered = [];
	for (let index = 0; index < MESSAGES; index++) {
		const sent = await deliver(address, token, index);
		delivered.push({ ...sent, message: await findMessage(sent.subject) });
	}
	const settle = await startJob("reclaim");
	await waitForJob(settle.id);
	const before = await report();
	check("files are served from the raw message", before.raw.rows >= MESSAGES * FILES_PER_MESSAGE, before.raw);
	check("files download byte-exact before the jobs", await filesIntact(delivered));

	console.log("\nMaterialize, killed after 3 files");
	const materialized = await crashAndConverge("materialize", 3, before);
	const afterMaterialize = await report();
	check("no file is served from the raw message any more", afterMaterialize.raw.rows === 0, afterMaterialize.raw);
	check("no row shares an object", afterMaterialize.shared.rows === 0, afterMaterialize.shared);
	check(
		"every raw row and every shared row got exactly one object",
		afterMaterialize.objects.keys === before.objects.keys + before.raw.rows + before.shared.rows &&
			materialized.converted === before.raw.rows,
		{ before: before.objects, after: afterMaterialize.objects, job: materialized },
	);
	check("files download byte-exact after materialize", await filesIntact(delivered));
	const verified = await json("/api/admin/attachment-storage?verify=1");
	check("verify reports nothing missing", verified.verify.missing.length === 0, verified.verify.missing);

	console.log("\nReclaim, killed after 2 messages");
	await crashAndConverge("reclaim", 2, afterMaterialize);
	const afterReclaim = await report();
	check("files are served from the raw message again", afterReclaim.raw.rows === before.raw.rows, afterReclaim.raw);
	check("reclaim has nothing left to look at", afterReclaim.reclaim?.pending.rows === 0, afterReclaim.reclaim);
	check(
		"the materialized objects are gone",
		afterReclaim.objects.keys === before.objects.keys + before.shared.rows,
		afterReclaim.objects,
	);
	check("files download byte-exact after reclaim", await filesIntact(delivered));
	const reverified = await json("/api/admin/attachment-storage?verify=1");
	check("verify still reports nothing missing", reverified.verify.missing.length === 0, reverified.verify.missing);

	console.log("\nReclaim again");
	const again = await waitForJob((await startJob("reclaim")).id);
	check("a second reclaim does nothing", again.done === 0 && again.converted === 0, again);

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed) process.exitCode = 1;
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
