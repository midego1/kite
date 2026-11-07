import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

/**
 * The card shown is the card saved: every proposal field that changes what approving `track_subscription` writes is
 * drawn on the Money Watch approval card (`data-card-field`), in both modes. A field the server saves but the card
 * hides would let mail text or a model-invented value be saved unseen.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-finance-chat-track-card-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { trackProposalCard } from "./src/components/modules/finance/track-proposal-card.tsx";
			export { showsEstimatedRenewal, withEdit } from "./src/components/modules/finance/track-proposal-utils.ts";
			export { AgentPendingActions } from "./src/components/agent/tool-activity.tsx";
			export { proposalCardBlock, proposalCardStatus } from "./src/components/agent/proposal-card-utils.ts";
			export { attachRequestBody, trackRequestBody } from "./src/lib/finance/chat-track-utils.ts";
			export { createElement } from "react";
			export { renderToStaticMarkup } from "react-dom/server";
		`,
		resolveDir: root,
		sourcefile: "card-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	jsx: "automatic",
	alias: {
		"next/navigation": "next/navigation.js",
		"next/link": "next/link.js",
		"next/headers": "next/headers.js",
		"next/server": "next/server.js",
	},
	logLevel: "silent",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
});
const m = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const full = {
	emailId: "m-1",
	subscriptionId: "fsub-1",
	vendor: "Acmeflix",
	plan: "Premium",
	amount: "17.99",
	currency: "USD",
	cycle: "monthly",
	nextRenewalOn: "2026-12-01",
	docType: "payment",
	documentOn: "2026-11-01",
	attachmentId: "att-1",
};
const other = {
	emailId: "m-2",
	subscriptionId: "fsub-2",
	vendor: "Other",
	plan: "Basic",
	amount: "2",
	currency: "EUR",
	cycle: "yearly",
	nextRenewalOn: "2027-01-01",
	docType: "invoice",
	documentOn: "2026-10-01",
	attachmentId: "att-2",
};
const save = {
	track: (input) => JSON.stringify(m.trackRequestBody(input, { mailboxId: "mailbox-1", today: "2026-11-07" })),
	attach: (input) => JSON.stringify(m.attachRequestBody(input, "2026-11-07")),
};

/** The proposal keys whose value changes what approving saves. */
function savedKeys(mode) {
	const input = { ...full, mode };
	const before = save[mode](input);
	assert.doesNotMatch(before, /"error"/, `the ${mode} fixture is savable`);
	return Object.keys(other).filter((key) => save[mode]({ ...input, [key]: other[key] }) !== before);
}

function renderedKeys(mode) {
	const details = {
		assisted: ["plan"],
		renewalEstimated: false,
		existing: { vendor: "Acmeflix" },
		attachmentName: "receipt.pdf",
		email: { subject: "Your receipt", from: "billing@acmeflix.example" },
	};
	const html = m.renderToStaticMarkup(
		m.createElement(m.trackProposalCard.Body, {
			input: { ...full, mode },
			details,
			edits: {},
			onEditsChange: () => {},
			disabled: false,
		}),
	);
	return { html, keys: new Set([...html.matchAll(/data-card-field="([^"]+)"/g)].map((match) => match[1])) };
}

for (const mode of ["track", "attach"])
	test(`every field approving a ${mode} card saves is drawn on the card`, () => {
		const saved = savedKeys(mode);
		assert.ok(saved.length >= (mode === "track" ? 10 : 6), saved.join(", "));
		const { keys } = renderedKeys(mode);
		for (const key of saved) assert.ok(keys.has(key), `${key} is saved but not on the ${mode} card`);
	});

test("the plan, like every field the assistant filled, is shown with its value and marked", () => {
	const { html } = renderedKeys("track");
	assert.match(html, /data-card-field="plan"[\s\S]*?from the assistant[\s\S]*?value="Premium"/);
	assert.match(html, /Your receipt/);
	assert.match(html, /receipt\.pdf/);
});

const estimatedDetails = { assisted: [], renewalEstimated: true, existing: null, attachmentName: null, email: null };

function renderTrack(edits) {
	return m.renderToStaticMarkup(
		m.createElement(m.trackProposalCard.Body, {
			input: { ...full, mode: "track" },
			details: estimatedDetails,
			edits,
			onEditsChange: () => {},
			disabled: false,
		}),
	);
}

test("changing the billing period clears a renewal Kite estimated from the old one, with its note", () => {
	assert.match(renderTrack({}), /estimated[\s\S]*?value="2026-12-01"/);
	const edits = m.withEdit({}, "cycle", "yearly", true);
	assert.deepEqual(edits, { cycle: "yearly", nextRenewalOn: null });
	const html = renderTrack(edits);
	assert.doesNotMatch(html, /estimated/);
	assert.doesNotMatch(html, /value="2026-12-01"/);
	// A date the user set, or one that was read rather than estimated, is kept.
	assert.deepEqual(m.withEdit({ nextRenewalOn: "2027-02-01" }, "cycle", "yearly", true), {
		nextRenewalOn: "2027-02-01",
		cycle: "yearly",
	});
	assert.deepEqual(m.withEdit({}, "cycle", "yearly", false), { cycle: "yearly" });
	assert.equal(m.withEdit({}, "cycle", "", true).cycle, null);
	// Typing a date of one's own drops the note too.
	assert.equal(
		m.showsEstimatedRenewal(
			{ nextRenewalOn: "2027-03-01" },
			{ renewalEstimated: true },
			{ nextRenewalOn: "2027-03-01" },
		),
		false,
	);
	assert.equal(m.showsEstimatedRenewal({ nextRenewalOn: "2026-12-01" }, { renewalEstimated: true }, {}), true);
});

test("approve waits for the module's own card, and stays off with a message when it fails to load", () => {
	assert.equal(m.proposalCardStatus(false, null), "none");
	assert.equal(m.proposalCardStatus(true, null), "loading");
	assert.equal(m.proposalCardStatus(true, { card: true }), "ready");
	assert.equal(m.proposalCardStatus(true, { card: false }), "none");
	assert.equal(m.proposalCardStatus(true, { failed: true }), "failed");
	assert.match(m.proposalCardBlock("loading"), /Loading/);
	assert.match(m.proposalCardBlock("failed"), /could not be loaded/);
	assert.equal(m.proposalCardBlock("ready"), null);
	assert.equal(m.proposalCardBlock("none"), null);

	// The first render, before the finance chunk arrives: core's lines, and no working approve button.
	const proposal = {
		action: "track_subscription",
		status: "pending_approval",
		moduleId: "finance",
		effect: "create",
		input: { ...full, mode: "track" },
		items: [{ label: "Track Acmeflix", detail: null }],
	};
	const html = m.renderToStaticMarkup(
		m.createElement(m.AgentPendingActions, {
			item: {
				id: "msg-1",
				recordId: "tool-1",
				role: "tool",
				content: JSON.stringify(proposal),
				toolName: "track_subscription",
			},
			onApproveAction: () => {},
			approvingId: null,
		}),
	);
	assert.match(html, /Loading the card…/);
	assert.match(html, /<button[^>]*disabled=""[^>]*>Approve and save<\/button>/);
});
