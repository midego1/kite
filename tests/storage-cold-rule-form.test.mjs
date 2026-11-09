import assert from "node:assert/strict";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const { coldRuleToForm, coldRuleToBody } = await bundleModules("kite-storage-cold-rule-form-", [
	["coldRuleToForm, coldRuleToBody", "src/app/(admin)/storage/cold-storage-utils.ts"],
]);

const MB = 1024 * 1024;
const rule = (minBytes) => ({
	objectClass: "mail",
	afterDays: 30,
	minBytes,
	target: "r2-ia",
	enabled: true,
	updatedAt: null,
});

test("a size floor small enough to round to 0.00 MB still shows and round-trips as nonzero", () => {
	const small = 5_000; // ~0.0048 MB: rounds to "0.00" at two decimals
	const form = coldRuleToForm(rule(small));
	assert.notEqual(form.minBytesMb, "", "a real floor is never shown as empty");
	assert.notEqual(Number(form.minBytesMb), 0, "the exact value is shown instead of a rounded-away zero");
	const parsed = coldRuleToBody({ ...form, afterDays: "30", target: "r2-ia", enabled: true });
	assert.ok("body" in parsed, "body" in parsed ? undefined : parsed.error);
	assert.equal(parsed.body.minBytes, small, "saving the form again without touching this field keeps the floor");
});

test("no floor stays empty, and an ordinary floor round-trips at two-decimal precision", () => {
	assert.equal(coldRuleToForm(rule(0)).minBytesMb, "");
	const ordinary = coldRuleToForm(rule(5 * MB));
	assert.equal(ordinary.minBytesMb, "5");
	const parsed = coldRuleToBody({ ...ordinary, afterDays: "30", target: "r2-ia", enabled: true });
	assert.ok("body" in parsed, "body" in parsed ? undefined : parsed.error);
	assert.equal(parsed.body.minBytes, 5 * MB);
});
