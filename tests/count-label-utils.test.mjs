import assert from "node:assert/strict";
import test from "node:test";
import { COUNT_MARKER, splitCountMessage } from "../src/components/messages/count-label-utils.ts";

const english = (count) => `${count} selected`;
const arabic = (count) => `المحدد: ${count}`;

test("the number comes out whole whichever side of the words it is on", () => {
	assert.deepEqual(splitCountMessage(english("975"), english(COUNT_MARKER)), {
		before: "",
		number: "975",
		after: " selected",
	});
	assert.deepEqual(splitCountMessage(arabic("975"), arabic(COUNT_MARKER)), {
		before: "المحدد: ",
		number: "975",
		after: "",
	});
});

test("a formatted number keeps its separators", () => {
	assert.equal(splitCountMessage(english("1,000"), english(COUNT_MARKER)).number, "1,000");
	assert.equal(splitCountMessage(arabic("١٬٠٠٠"), arabic(COUNT_MARKER)).number, "١٬٠٠٠");
});

test("a message without a placeholder is returned whole", () => {
	assert.deepEqual(splitCountMessage("Selected", "Selected"), { before: "Selected", number: "", after: "" });
});
