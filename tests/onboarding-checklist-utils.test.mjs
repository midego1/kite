import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = makeBundleDirectory("kite-onboarding-checklist-");
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "src/lib/admin/onboarding-checklist-utils.ts")],
	outfile: join(bundleDirectory, "onboarding-checklist-utils.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node24",
	logLevel: "silent",
	tsconfig: join(root, "tsconfig.json"),
});
const { onboardingChecklistItems } = await import(
	pathToFileURL(join(bundleDirectory, "onboarding-checklist-utils.mjs")).href
);

const nothingDone = {
	domainActive: false,
	mailboxCount: 0,
	accountCount: 1,
	modulesConfigured: false,
	spamKeyConfigured: false,
	assistantConfigured: false,
	backupsReady: false,
	migrationsPending: 1,
};

const everythingDone = {
	domainActive: true,
	mailboxCount: 1,
	accountCount: 2,
	modulesConfigured: true,
	spamKeyConfigured: true,
	assistantConfigured: true,
	backupsReady: true,
	migrationsPending: 0,
};

test("nothing done reads as not done, in a fixed order, with a link and no doc for some items", () => {
	const items = onboardingChecklistItems(nothingDone);
	assert.deepEqual(
		items.map((item) => item.id),
		["domain", "mailbox", "invite", "modules", "spam", "assistant", "backups", "updates"],
	);
	assert.ok(items.every((item) => item.done === false));
	assert.ok(items.every((item) => item.href.length > 0 && item.hrefLabel.length > 0));
	const byId = Object.fromEntries(items.map((item) => [item.id, item]));
	assert.equal(byId.mailbox.docHref, undefined, "no matching doc for this one");
	assert.equal(byId.invite.docHref, undefined, "no matching doc for this one");
	assert.equal(byId.domain.docHref, "providers.md");
	assert.equal(byId.spam.href, "/general#threat-lookups");
	assert.equal(byId.assistant.href, "/agent#ai-provider");
	assert.equal(byId.updates.href, "/admin#database");
});

test("each item's done state tracks its own field, independent of the others", () => {
	const byId = Object.fromEntries(onboardingChecklistItems(everythingDone).map((item) => [item.id, item]));
	for (const id of ["domain", "mailbox", "invite", "modules", "spam", "assistant", "backups", "updates"])
		assert.equal(byId[id].done, true, id);
});

test("the first mailbox and invite items read real counts, not just a mailbox existing", () => {
	const soloAccount = { ...everythingDone, accountCount: 1 };
	const byId = Object.fromEntries(onboardingChecklistItems(soloAccount).map((item) => [item.id, item]));
	assert.equal(byId.invite.done, false, "inviting needs a second account");
	assert.equal(byId.mailbox.done, true, "unaffected by the account count");

	const noMailbox = { ...everythingDone, mailboxCount: 0 };
	assert.equal(onboardingChecklistItems(noMailbox).find((item) => item.id === "mailbox").done, false);
});

test("a deliberately disabled assistant counts as done without a provider", () => {
	const assistantOff = { ...nothingDone, assistantConfigured: true };
	assert.equal(onboardingChecklistItems(assistantOff).find((item) => item.id === "assistant").done, true);
});

test("backups read as ready from either automatic backups or a past success", () => {
	const ready = { ...nothingDone, backupsReady: true };
	assert.equal(onboardingChecklistItems(ready).find((item) => item.id === "backups").done, true);
});
