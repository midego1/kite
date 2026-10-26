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
			export { appliedPlaces, chatActionPlan, chatActionState, chatProposalSchema, safeActionError, storedChatActionState, undoTargets } from "./src/lib/agent/chat-actions-utils.ts";
			export { FOLDER_COLOR_NAMES, folderColorValue } from "./src/lib/agent/organize-tools-utils.ts";
			export { canSeeAction, getActionMeta, userExecuteRefusal, undoRefusal } from "./src/lib/agent/auto-read/actions-utils.ts";
			export { approveActionLabel, approvedActionText, canUndoAction, undoneActionText } from "./src/components/agent/chat-action-utils.ts";
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
	appliedPlaces,
	agentToolLabel,
	approveActionLabel,
	approvedActionText,
	canSeeAction,
	canUndoAction,
	chatActionPlan,
	chatProposalSchema,
	folderColorValue,
	getActionMeta,
	chatActionState,
	safeActionError,
	storedChatActionState,
	undoTargets,
	undoneActionText,
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

test("only rows carrying the chat marker are chat actions, and undo targets only what the action changed", () => {
	const inbox = { id: "a", status: "received", folderId: null, read: false };
	const archived = { ...inbox, status: "archived" };
	const filed = { id: "b", status: "received", folderId: "f1", read: true };
	const state = chatActionState([inbox, filed], [archived, filed]);
	assert.deepEqual(state, { source: "chat", messages: [inbox, filed], applied: [archived, filed] });
	assert.deepEqual(storedChatActionState(JSON.parse(JSON.stringify(state))), state);
	// A phishing "Mark as spam" row saves one place without the marker, even with a messages list.
	assert.equal(storedChatActionState({ status: "received", folderId: null }), null);
	assert.equal(storedChatActionState({ messages: [inbox] }), null);
	assert.equal(storedChatActionState(null), null);
	assert.deepEqual(storedChatActionState({ source: "chat", messages: [inbox, { id: "x" }, null], applied: "bad" }), {
		source: "chat",
		messages: [inbox],
		applied: [],
	});
	assert.deepEqual(undoTargets(state, "place"), [{ before: inbox, applied: archived }]);
	assert.deepEqual(undoTargets(state, "read"), []);
	const marked = chatActionState([inbox, filed], [{ ...inbox, read: true }, filed]);
	assert.deepEqual(undoTargets(marked, "read"), [{ before: inbox, applied: { ...inbox, read: true } }]);
	// A message missing after the effect (deleted meanwhile) is not a target.
	assert.deepEqual(undoTargets(chatActionState([inbox], []), "place"), []);
});

test("the applied state derives from the action's own writes, never from a later live read", () => {
	const inbox = { id: "a", status: "received", folderId: null, read: true };
	const spam = { id: "b", status: "spam", folderId: "f1", read: false };
	const plan = (value) => chatActionPlan(parse(value));
	// A plan without an audit row changes nothing.
	assert.deepEqual(appliedPlaces([inbox], plan({ action: "discard_draft", draftId: "d", expectedRevision: 1 })), [
		inbox,
	]);
	// Marking read or unread flips only the read flag.
	assert.deepEqual(appliedPlaces([inbox], plan({ action: "mark_email_read", emailId: "a", read: false })), [
		{ ...inbox, read: false },
	]);
	assert.deepEqual(appliedPlaces([spam], plan({ action: "mark_emails_read", emailIds: ["b"] })), [
		{ ...spam, read: true },
	]);
	// A move sets the status and keeps the folder, except reporting spam unfiles, as does moving spam back.
	const move = (destination, emailIds = ["a"]) => plan({ action: "move_emails", emailIds, destination });
	assert.deepEqual(appliedPlaces([inbox], move("archived")), [{ ...inbox, status: "archived" }]);
	assert.deepEqual(appliedPlaces([spam], move("spam", ["b"])), [{ ...spam, folderId: null }]);
	assert.deepEqual(appliedPlaces([spam], move("inbox", ["b"])), [{ ...spam, status: "received", folderId: null }]);
	assert.deepEqual(appliedPlaces([inbox], move("inbox")), [inbox]);
	// Filing makes the mail received in that folder; a plan without a folderId files nowhere.
	assert.deepEqual(appliedPlaces([inbox], plan({ action: "move_emails_to_folder", emailIds: ["a"], folderId: "f9" })), [
		{ ...inbox, status: "received", folderId: "f9" },
	]);
	assert.deepEqual(
		appliedPlaces([inbox], {
			tool: "move_emails_to_folder",
			input: {},
			audit: { action: "set_folder", variant: "", emailIds: ["a"] },
		}),
		[{ ...inbox, status: "received", folderId: null }],
	);
	// Creating a folder touches no messages.
	assert.deepEqual(appliedPlaces([inbox], plan({ action: "create_folder", name: "Bills", color: "green" })), [inbox]);
});

test("database errors never reach the user or the audit row as SQL", () => {
	assert.equal(safeActionError(new Error("Folder not found in this mailbox")), "Folder not found in this mailbox");
	assert.equal(
		safeActionError(new Error('Failed query: insert into "folders" ... params: fld_1,Bills')),
		"The action could not be completed",
	);
	assert.equal(
		safeActionError(new Error("UNIQUE constraint failed: folders.mailbox_id")),
		"The action could not be completed",
	);
	assert.equal(safeActionError(new Error("D1_ERROR: oops")), "The action could not be completed");
	assert.equal(safeActionError("plain"), "plain");
	assert.equal(safeActionError(new Error("")), "The action could not be completed");
});

test("an undo that left some emails says how many went back", () => {
	assert.equal(undoneActionText({ action: "move_emails" }), "Undone.");
	assert.equal(undoneActionText({ action: "move_emails", undo: { restored: 5, total: 5 } }), "Undone.");
	assert.equal(
		undoneActionText({ action: "move_emails", undo: { restored: 2, total: 5 } }),
		"Undid 2 of 5; 3 had moved since.",
	);
	assert.equal(
		undoneActionText({ action: "mark_emails_unread", undo: { restored: 1, total: 2 } }),
		"Undid 1 of 2; 1 had changed since.",
	);
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

test("every proposal has approve and done text, also when optional fields are missing", () => {
	const cases = [
		[{ action: "discard_draft" }, "Approve discard", "Draft discarded."],
		[{ action: "mark_email_read", read: true, emailId: "a" }, "Approve mark as read", "Marked as read."],
		[{ action: "mark_email_read", read: false, emailId: "a" }, "Approve mark as unread", "Marked as unread."],
		[{ action: "mark_emails_read", emailIds: ["a"] }, "Approve mark 1 email as read", "Marked 1 email as read."],
		[{ action: "mark_emails_unread" }, "Approve mark 0 emails as unread", "Marked 0 emails as unread."],
		[{ action: "create_folder" }, "Approve new folder “”", "Created folder “”."],
		[{ action: "move_emails_to_folder" }, "Approve move to “folder”", "Moved 0 emails to “folder”."],
		[{ action: "move_email", emailId: "a", destination: "spam" }, "Approve move to spam", "Moved 1 email to spam."],
		[
			{ action: "move_emails", emailIds: ["a"], destination: "inbox" },
			"Approve move to the inbox",
			"Moved 1 email to the inbox.",
		],
		[
			{ action: "move_emails", emailIds: ["a"], destination: "elsewhere" },
			"Approve move to elsewhere",
			"Moved 1 email to elsewhere.",
		],
	];
	for (const [fields, approve, done] of cases) {
		const proposal = { status: "pending_approval", ...fields };
		assert.equal(approveActionLabel(proposal), approve);
		assert.equal(approvedActionText({ ...proposal, status: "approved" }), done);
	}
	assert.equal(
		canUndoAction({ action: "move_emails", status: "approved", actionId: "aact-1", undoUntil: null }, NOW),
		false,
	);
});
