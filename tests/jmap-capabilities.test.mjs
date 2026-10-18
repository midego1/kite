import assert from "node:assert/strict";
import test from "node:test";
import { jmap, jmapContext } from "./support/jmap-database.mjs";

const { SUPPORTED_CAPABILITIES, processRequest, validateRequest } = jmap;

const VACATION = "urn:ietf:params:jmap:vacationresponse";
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

test("a body that is not a request is still notRequest", () => {
	assert.throws(() => validateRequest({ using: ["urn:ietf:params:jmap:core"] }), { type: "notRequest" });
	assert.throws(() => validateRequest(null), { type: "notRequest" });
});
