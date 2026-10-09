import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-step-limit-");
after(() => rmSync(outDir, { recursive: true, force: true }));

async function bundle(entry, outfile) {
	await build({
		entryPoints: [join(root, entry)],
		outfile: join(outDir, outfile),
		bundle: true,
		sourcemap: "inline",
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
		alias: { "@": join(root, "src") },
		external: ["react", "react-dom", "next", "next/*"],
	});
	return import(pathToFileURL(join(outDir, outfile)).href);
}

const limits = await bundle("src/lib/agent/step-limit-utils.ts", "limits.mjs");
const validators = await bundle("src/lib/validators.ts", "validators.mjs");

test("the step limit defaults to 15 and is clamped to 3-30", () => {
	assert.equal(limits.AGENT_MAX_STEPS_DEFAULT, 15);
	assert.equal(limits.clampAgentMaxSteps(undefined), 15);
	assert.equal(limits.clampAgentMaxSteps(null), 15);
	assert.equal(limits.clampAgentMaxSteps(Number.NaN), 15);
	assert.equal(limits.clampAgentMaxSteps(1), 3);
	assert.equal(limits.clampAgentMaxSteps(100), 30);
	assert.equal(limits.clampAgentMaxSteps(12.4), 12);
	assert.equal(limits.clampAgentMaxSteps(7), 7);
	assert.equal(limits.isAgentMaxSteps(3), true);
	assert.equal(limits.isAgentMaxSteps(30), true);
	assert.equal(limits.isAgentMaxSteps(2), false);
	assert.equal(limits.isAgentMaxSteps(31), false);
	assert.equal(limits.isAgentMaxSteps(10.5), false);
	assert.equal(limits.isAgentMaxSteps("10"), false);
});

test("the assistant settings request accepts only whole steps in range", () => {
	const schema = validators.updateAssistantSettingsSchema;
	assert.deepEqual(schema.parse({ maxSteps: 20 }), { maxSteps: 20 });
	for (const maxSteps of [2, 31, 4.5, "10", null]) assert.equal(schema.safeParse({ maxSteps }).success, false);
	assert.equal(schema.safeParse({}).success, false);
});

test("only the final allowed step switches tools off and asks for an answer", () => {
	assert.equal(limits.agentStepSettings(0, 5, "system"), undefined);
	assert.equal(limits.agentStepSettings(3, 5, "system"), undefined);
	const last = limits.agentStepSettings(4, 5, "system");
	assert.equal(last.toolChoice, "none");
	assert.ok(last.instructions.startsWith("system\n\n"));
	assert.match(last.instructions, /ran out of steps/);
	assert.equal(limits.agentStepSettings(5, 5, "system")?.toolChoice, "none");
});
