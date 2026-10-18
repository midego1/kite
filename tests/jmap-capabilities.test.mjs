import assert from "node:assert/strict";
import test from "node:test";
import { jmap, jmapContext } from "./support/jmap-database.mjs";

const { SUPPORTED_CAPABILITIES, processRequest, validateRequest } = jmap;

const VACATION = "urn:ietf:params:jmap:vacationresponse";
const SMIME = "urn:ietf:params:jmap:smimeverify";
const request = (using, methodCalls = [["Core/echo", { echo: true }, "c0"]]) => ({ using, methodCalls });

test("the capabilities the server advertises are accepted", () => {
	for (const capability of SUPPORTED_CAPABILITIES)
		assert.deepEqual(validateRequest(request([capability])).using, [capability]);
});

test("an unimplemented IETF extension in using is ignored (Flectar Mail sends vacationresponse)", () => {
	const using = [...SUPPORTED_CAPABILITIES, VACATION, "urn:ietf:params:jmap:sieve"];
	assert.deepEqual(validateRequest(request(using)).using, using);
});

test("a capability from another namespace is still unknownCapability", () => {
	for (const urn of ["https://example.com/apis/foobar", "urn:example:jmap:core", "urn:ietf:params:jmapx:mail"]) {
		assert.throws(
			() => validateRequest(request(["urn:ietf:params:jmap:core", urn])),
			(error) => error.type === "unknownCapability" && error.message === urn,
			urn,
		);
	}
});

test("a module URN is accepted only while the module surface lists it", () => {
	const modules = { capabilities: { "urn:test:calendars": {} } };
	const using = ["urn:ietf:params:jmap:core", "urn:test:calendars"];
	assert.doesNotThrow(() => validateRequest(request(using), modules));
	assert.throws(
		() => validateRequest(request(using)),
		(error) => error.type === "unknownCapability",
	);
});

test("a method of an ignored extension answers unknownMethod while the rest of the request runs", async (t) => {
	const { ctx } = await jmapContext(t);
	const parsed = validateRequest(
		request(
			["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", VACATION],
			[
				["VacationResponse/get", { accountId: "owner" }, "c0"],
				["Core/echo", { hello: "world" }, "c1"],
			],
		),
	);
	const response = await processRequest(ctx, parsed);
	assert.deepEqual(response.methodResponses, [
		["error", { type: "unknownMethod" }, "c0"],
		["Core/echo", { hello: "world" }, "c1"],
	]);
});

test("Email/get rejects unsupported smimeStatus but accepts an unused smimeverify capability", async (t) => {
	const { database, ctx, mailboxIds } = await jmapContext(t);
	database.db.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, status, subject, created_at)
		VALUES ('msg-1', 'owner', '${mailboxIds[0]}', 'inbound', 'a@example.net', 'b@example.com', 'received', 'Hello', 1);
	`);
	const parsed = validateRequest(
		request(
			["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", SMIME],
			[
				["Email/get", { ids: ["msg-1"], properties: ["id", "smimeStatus"] }, "unsupported"],
				["Email/get", { ids: [], properties: ["smimeStatus"] }, "empty"],
				["Email/get", { ids: ["msg-1"], properties: ["id", "subject"] }, "supported"],
				["Core/echo", { hello: "world" }, "echo"],
			],
		),
	);
	const { methodResponses } = await processRequest(ctx, parsed);
	for (const [index, callId] of ["unsupported", "empty"].entries()) {
		assert.equal(methodResponses[index][0], "error");
		assert.equal(methodResponses[index][1].type, "invalidArguments");
		assert.equal(methodResponses[index][2], callId);
	}
	assert.equal(methodResponses[2][0], "Email/get");
	assert.deepEqual(methodResponses[2][1].list, [{ id: "msg-1", subject: "Hello" }]);
	assert.deepEqual(methodResponses[2][1].notFound, []);
	assert.deepEqual(methodResponses[3], ["Core/echo", { hello: "world" }, "echo"]);
});

test("a body that is not a request is still notRequest", () => {
	assert.throws(() => validateRequest({ using: ["urn:ietf:params:jmap:core"] }), { type: "notRequest" });
	assert.throws(() => validateRequest(null), { type: "notRequest" });
});
