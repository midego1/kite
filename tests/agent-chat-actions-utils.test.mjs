import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = makeBundleDirectory("kite-agent-chat-actions-utils-");
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { chatActionPlan, chatProposalSchema, movedStatus, storedMessagePlaces } from "./src/lib/agent/chat-actions-utils.ts";
			export { FOLDER_COLOR_NAMES, folderColorValue } from "./src/lib/agent/organize-tools-utils.ts";
			export { canSeeAction, getActionMeta, userExecuteRefusal, undoRefusal } from "./src/lib/agent/auto-read/actions-utils.ts";
			export { approveActionLabel, approvedActionText, canUndoAction } from "./src/components/agent/chat-action-utils.ts";
			export { agentActionProposal, agentToolLabel } from "./src/components/agent/utils.ts";
			export { actionLabel, actionTarget } from "./src/components/agent/agent-activity-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "chat-actions-utils-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});
const {
	FOLDER_COLOR_NAMES,
	actionLabel,
	actionTarget,
	agentActionProposal,
	agentToolLabel,
	approveActionLabel,
	approvedActionText,
	canSeeAction,
	canUndoAction,
	chatActionPlan,
	chatProposalSchema,
	folderColorValue,
	getActionMeta,
	movedStatus,
	storedMessagePlaces,
	undoRefusal,
	userExecuteRefusal,
} = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const NOW = new Date("2026-10-26T12:00:00.000Z");
const parse = (value) => chatProposalSchema.parse({ status: "pending_approval", ...value });

test("each approved proposal maps to its tool input and the audit row that makes it undoable", () => {
	assert.deepEqual(
		chatActionPlan(parse({ action: "mark_emails_unread", emailIds: ["a", "b"], read: false, emails: [] })),
		{
			tool: "mark_emails_unread",
			input: { emailIds: ["a", "b"] },
			audit: { action: "mark_read", variant: "unread", emailIds: ["a", "b"] },
		},
	);
	assert.deepEqual(chatActionPlan(parse({ action: "mark_email_read", emailId: "a", read: true })).audit, {
		action: "mark_read",
		variant: "read",
		emailIds: ["a"],
	});
	assert.deepEqual(chatActionPlan(parse({ action: "move_emails", emailIds: ["a"], destination: "trash" })), {
		tool: "move_emails",
		input: { emailIds: ["a"], destination: "trash" },
		audit: { action: "move", variant: "trash", emailIds: ["a"] },
	});
	assert.deepEqual(chatActionPlan(parse({ action: "move_email", emailIds: ["a"], destination: "archived" })).input, {
		emailId: "a",
		destination: "archived",
	});
	assert.deepEqual(
		chatActionPlan(parse({ action: "move_emails_to_folder", emailIds: ["a"], folderId: "fld-1", folderName: "Bills" })),
		{
			tool: "move_emails_to_folder",
			input: { emailIds: ["a"], folderId: "fld-1" },
			audit: { action: "set_folder", variant: "", emailIds: ["a"] },
		},
	);
	assert.deepEqual(chatActionPlan(parse({ action: "create_folder", name: "Bills", color: "green" })), {
		tool: "create_folder",
		input: { name: "Bills", color: "green" },
		audit: { action: "create_folder", variant: "", emailIds: [] },
	});
	assert.equal(chatActionPlan(parse({ action: "discard_draft", draftId: "d", expectedRevision: 1 })).audit, null);
});

test("a proposal over 20 emails, without ids or already approved is never approvable", () => {
	const ids = Array.from({ length: 21 }, (_, index) => `m${index}`);
	assert.equal(
		chatProposalSchema.safeParse({ action: "mark_emails_read", status: "pending_approval", emailIds: ids }).success,
		false,
	);
	assert.equal(
		chatProposalSchema.safeParse({ action: "mark_emails_read", status: "pending_approval", emailIds: [] }).success,
		false,
	);
	assert.equal(
		chatProposalSchema.safeParse({
			action: "move_emails_to_folder",
			status: "approved",
			emailIds: ["a"],
			folderId: "f",
		}).success,
		false,
	);
	assert.equal(
		chatProposalSchema.safeParse({ action: "move_emails_to_folder", status: "pending_approval", emailIds: ["a"] })
			.success,
		false,
	);
});

test("stored message places are read defensively and moves know the status they leave", () => {
	const place = { id: "a", status: "received", folderId: null, read: false };
	assert.deepEqual(storedMessagePlaces({ messages: [place, { id: "b" }, null] }), [place]);
	assert.equal(storedMessagePlaces({ status: "received", folderId: null }), null);
	assert.equal(storedMessagePlaces(null), null);
	assert.equal(movedStatus("inbox"), "received");
	assert.equal(movedStatus("archived"), "archived");
});

test("folder colours are chosen by name and fall back to nothing for an unknown one", () => {
	assert.equal(FOLDER_COLOR_NAMES[0], "blue");
	assert.ok(FOLDER_COLOR_NAMES.includes("green"));
	assert.equal(folderColorValue("Green"), "#16a34a");
	assert.equal(folderColorValue(" teal "), "#0d9488");
	assert.equal(folderColorValue("chartreuse"), null);
	assert.equal(folderColorValue(undefined), null);
});

test("read state needs reading access, moves and folders full access, and the undo follows the same rule", () => {
	const reader = { canRead: true, canManage: false, canSendOnBehalf: false };
	const manager = { canRead: true, canManage: true, canSendOnBehalf: true };
	assert.equal(userExecuteRefusal(getActionMeta("mark_read"), "unread", reader), null);
	assert.equal(userExecuteRefusal(getActionMeta("mark_read"), "sideways", reader), "variant_not_supported");
	assert.equal(userExecuteRefusal(getActionMeta("set_folder"), "", reader), "missing_manage");
	assert.equal(userExecuteRefusal(getActionMeta("create_folder"), "", reader), "missing_manage");
	assert.equal(userExecuteRefusal(getActionMeta("move"), "archived", manager), null);
	assert.equal(userExecuteRefusal(getActionMeta("move"), "spam", manager), null);

	const row = (extra) => ({
		action: "mark_read",
		variant: "unread",
		status: "applied",
		actingUserId: "u1",
		undoUntil: new Date(NOW.getTime() + 60_000),
		...extra,
	});
	assert.equal(canSeeAction(row(), "u1", reader), true);
	assert.equal(canSeeAction(row(), "u2", reader), false);
	assert.equal(canSeeAction(row({ action: "set_folder", variant: "" }), "u1", reader), false);
	assert.equal(canSeeAction(row({ action: "set_folder", variant: "" }), "u2", manager), true);
	assert.equal(canSeeAction(row(), "u1", { ...reader, canRead: false }), false);
	assert.equal(undoRefusal(row(), "u1", reader, NOW), null);
	assert.equal(undoRefusal(row({ action: "set_folder", variant: "" }), "u1", reader, NOW).status, 403);
	assert.equal(undoRefusal(row({ undoUntil: new Date(NOW.getTime() - 1) }), "u1", reader, NOW).status, 409);
});

test("the panel recognises every proposal, labels its approve button and offers Undo inside the window", () => {
	const content = (value) => JSON.stringify(value);
	for (const action of ["mark_emails_read", "mark_emails_unread", "create_folder", "move_emails_to_folder"])
		assert.equal(agentActionProposal(content({ action, status: "pending_approval" }))?.action, action);
	assert.equal(agentActionProposal(content({ action: "list_folders", status: "pending_approval" })), null);
	assert.equal(agentActionProposal(content({ action: "create_folder", status: "undone" }))?.status, "undone");

	assert.equal(
		approveActionLabel({ action: "mark_emails_unread", status: "pending_approval", emailIds: ["a", "b"] }),
		"Approve mark 2 emails as unread",
	);
	assert.equal(
		approveActionLabel({ action: "move_emails_to_folder", status: "pending_approval", folderName: "Bills" }),
		"Approve move to “Bills”",
	);
	assert.equal(
		approveActionLabel({ action: "create_folder", status: "pending_approval", name: "Bills" }),
		"Approve new folder “Bills”",
	);
	assert.equal(
		approveActionLabel({ action: "move_emails", status: "pending_approval", destination: "archived" }),
		"Approve move to the archive",
	);
	assert.equal(
		approveActionLabel({ action: "mark_email_read", status: "pending_approval", read: false }),
		"Approve mark as unread",
	);
	assert.equal(approveActionLabel({ action: "discard_draft", status: "pending_approval" }), "Approve discard");
	assert.equal(
		approvedActionText({ action: "move_emails_to_folder", status: "approved", emailIds: ["a"], folderName: "Bills" }),
		"Moved 1 email to “Bills”.",
	);
	assert.equal(
		approvedActionText({ action: "move_emails", status: "approved", emailIds: ["a", "b"], destination: "trash" }),
		"Moved 2 emails to trash.",
	);

	const approved = {
		action: "mark_emails_read",
		status: "approved",
		actionId: "aact-1",
		undoUntil: "2026-11-02T12:00:00.000Z",
	};
	assert.equal(canUndoAction(approved, NOW), true);
	assert.equal(canUndoAction({ ...approved, undoUntil: "2026-10-26T11:00:00.000Z" }, NOW), false);
	assert.equal(canUndoAction({ ...approved, actionId: undefined }, NOW), false);
	assert.equal(canUndoAction({ ...approved, status: "undone" }, NOW), false);
});

test("tool labels count the emails prepared, changed and undone", () => {
	const emails = [{ id: "a" }, { id: "b" }];
	const label = (name, status) => agentToolLabel(name, "used", JSON.stringify({ status, emails })).label;
	assert.equal(label("mark_emails_unread", "pending_approval"), "Prepared 2 emails for review");
	assert.equal(label("mark_emails_unread", "approved"), "Marked 2 emails");
	assert.equal(label("move_emails_to_folder", "approved"), "Filed 2 emails");
	assert.equal(label("move_emails", "approved"), "Moved 2 emails");
	assert.equal(label("move_emails", "undone"), "Undid the change to 2 emails");
	assert.equal(agentToolLabel("list_folders", "used", JSON.stringify({ folders: [] })).label, "Listed folders");
});

test("Activity names chat actions with their folder and count, and links where the mail went", () => {
	const row = (extra) => ({
		action: "move",
		variant: "archived",
		undoOf: null,
		status: "applied",
		messageId: "msg-1",
		subject: "Figures",
		draftAvailable: false,
		after: { count: 3 },
		...extra,
	});
	assert.equal(actionLabel(row()), "Moved to the archive (3 emails)");
	assert.equal(actionLabel(row({ action: "mark_read", variant: "unread", after: { count: 1 } })), "Marked as unread");
	assert.equal(
		actionLabel(row({ action: "set_folder", variant: "", after: { count: 2, folderName: "Bills", folderId: "f1" } })),
		"Moved to a folder “Bills” (2 emails)",
	);
	assert.equal(
		actionLabel(row({ action: "create_folder", variant: "", after: { folderName: "Bills", count: 0 } })),
		"Created a folder “Bills”",
	);
	assert.equal(actionLabel(row({ undoOf: "aact-0", after: null })), "Undid: moved to the archive");
	assert.equal(actionLabel(row({ variant: "spam", after: null })), "Moved the message to spam");

	assert.deepEqual(actionTarget(row()), { href: "/archived/msg-1", label: "Figures" });
	assert.deepEqual(actionTarget(row({ variant: "inbox" })), { href: "/inbox/msg-1", label: "Figures" });
	assert.deepEqual(actionTarget(row({ status: "undone" })), { href: "/inbox/msg-1", label: "Figures" });
	assert.deepEqual(actionTarget(row({ action: "set_folder", variant: "", after: { folderId: "f1" } })), {
		href: "/folders/f1/msg-1",
		label: "Figures",
	});
	assert.deepEqual(
		actionTarget(row({ action: "create_folder", variant: "", messageId: null, after: { folderId: "f1" } })),
		{
			href: "/folders/f1",
			label: "Open folder",
		},
	);
	assert.equal(
		actionTarget(row({ action: "create_folder", status: "undone", messageId: null, after: { folderId: "f1" } })),
		null,
	);
});
