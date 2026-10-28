import { decodeModifiedUtf7, type ImapListedMailbox } from "@/lib/imap/protocol-utils";
import type { AccountFolderRequest, ImportFolderRole, PlannedImportFolder } from "./folder-mapping-types";

/** Kite folder names are at most this long (`folderSchema`). */
const MAX_FOLDER_NAME = 80;
/** The most folders one account job copies. */
const MAX_ACCOUNT_FOLDERS = 500;
/** All Mail on Gmail: one destination per message, from its labels. */
export const GMAIL_LABELS_DESTINATION = "gmail:labels";

const SPECIAL_USE: Record<string, ImportFolderRole | "drafts" | "virtual"> = {
	"\\sent": "sent",
	"\\archive": "archive",
	"\\junk": "junk",
	"\\trash": "trash",
	"\\drafts": "drafts",
	"\\all": "all",
	"\\flagged": "virtual",
	"\\important": "virtual",
};

/** Names a server without special-use attributes gives its standard folders, compared in lower case. */
const NAMED_ROLES: Record<string, ImportFolderRole | "drafts"> = {
	sent: "sent",
	"sent items": "sent",
	"sent messages": "sent",
	"sent mail": "sent",
	archive: "archive",
	archives: "archive",
	junk: "junk",
	spam: "junk",
	"junk e-mail": "junk",
	"junk email": "junk",
	"bulk mail": "junk",
	trash: "trash",
	"deleted items": "trash",
	"deleted messages": "trash",
	bin: "trash",
	drafts: "drafts",
};

const SYSTEM_DESTINATION: Record<Exclude<ImportFolderRole, "user" | "all">, string> = {
	inbox: "system:inbox",
	sent: "system:sent",
	archive: "system:archived",
	junk: "system:spam",
	trash: "system:trash",
};

/** Copied by default; spam and trash are offered but off, as in the spec's table. */
const INCLUDED_BY_DEFAULT: Record<ImportFolderRole, boolean> = {
	inbox: true,
	sent: true,
	archive: true,
	user: true,
	all: true,
	junk: false,
	trash: false,
};

/** INBOX, Sent, Archive, the user's folders alphabetically, then Junk and Trash. */
const ROLE_ORDER: Record<ImportFolderRole, number> = {
	inbox: 0,
	all: 0,
	sent: 1,
	archive: 2,
	user: 3,
	junk: 4,
	trash: 5,
};

function segments(mailbox: Pick<ImapListedMailbox, "name" | "delimiter">): string[] {
	const parts = mailbox.delimiter ? mailbox.name.split(mailbox.delimiter) : [mailbox.name];
	return parts.map((part) => decodeModifiedUtf7(part).trim()).filter(Boolean);
}

/**
 * @public Exercised by the unit tests. The flat Kite folder name of a source folder (Kite folders do not nest): its decoded path joined with ` / `,
 * without a leading `INBOX` that servers such as Courier put every folder under.
 */
export function flattenFolderName(mailbox: Pick<ImapListedMailbox, "name" | "delimiter">): string {
	const parts = segments(mailbox);
	const path = parts.length > 1 && parts[0].toUpperCase() === "INBOX" ? parts.slice(1) : parts;
	return (path.join(" / ") || mailbox.name).slice(0, MAX_FOLDER_NAME).trim();
}

function attributeRole(mailbox: ImapListedMailbox): ImportFolderRole | "drafts" | "virtual" | null {
	for (const attribute of mailbox.attributes) {
		const role = SPECIAL_USE[attribute.toLowerCase()];
		if (role) return role;
	}
	return null;
}

/** A top-level folder (or a child of INBOX) with a standard name, for servers that send no special-use attributes. */
function namedRole(mailbox: ImapListedMailbox): ImportFolderRole | "drafts" | null {
	const parts = segments(mailbox);
	const leaf = parts.length === 1 || (parts.length === 2 && parts[0].toUpperCase() === "INBOX") ? parts.at(-1) : null;
	return leaf ? (NAMED_ROLES[leaf.toLowerCase()] ?? null) : null;
}

const isSelectable = (mailbox: ImapListedMailbox) =>
	!mailbox.attributes.some((attribute) => /^\\(noselect|nonexistent)$/i.test(attribute));

/**
 * What a whole-account import proposes for each source folder (spec §4.1): its role, whether it is copied and where
 * it goes. Drafts and the virtual `\Flagged` and `\Important` folders are not offered; `\All` only on Gmail, where it
 * is the one folder copied (with `\Junk` and `\Trash`, off), since every label folder is a view of it.
 */
export function planAccountFolders(
	mailboxes: readonly ImapListedMailbox[],
	options: { gmail: boolean },
): PlannedImportFolder[] {
	const selectable = mailboxes.filter(isSelectable);
	const announced = new Set(selectable.map(attributeRole).filter(Boolean));
	const planned: PlannedImportFolder[] = [];
	for (const mailbox of selectable) {
		const byAttribute = attributeRole(mailbox);
		const byName = byAttribute ? null : namedRole(mailbox);
		// A name only counts where the server announced no folder with that special use.
		const role =
			mailbox.name.toUpperCase() === "INBOX"
				? "inbox"
				: (byAttribute ?? (byName && !announced.has(byName) ? byName : "user"));
		if (role === "drafts" || role === "virtual") continue;
		if (options.gmail ? !["all", "junk", "trash"].includes(role) : role === "all") continue;
		const displayName = role === "inbox" ? "INBOX" : flattenFolderName(mailbox);
		planned.push({
			sourceName: mailbox.name,
			displayName,
			role,
			include: INCLUDED_BY_DEFAULT[role],
			destination:
				role === "all" ? GMAIL_LABELS_DESTINATION : role === "user" ? `new:${displayName}` : SYSTEM_DESTINATION[role],
		});
	}
	return planned.sort(
		(a, b) =>
			ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
			(a.role === "user" ? a.displayName.localeCompare(b.displayName, "en", { sensitivity: "base" }) : 0),
	);
}

/**
 * Where one Gmail message from All Mail goes (spec §4.1): `\Inbox` → Inbox, else `\Sent` → Sent, else its first user
 * label alphabetically → that Kite folder, else Archive. Drafts are skipped. `userLabels` counts its user labels, so
 * the job can say how many messages had several and went to the first.
 */
export function gmailLabelDestination(labels: readonly string[]): { destination: string | null; userLabels: number } {
	const system = new Set(labels.filter((label) => label.startsWith("\\")).map((label) => label.toLowerCase()));
	const user = labels
		.filter((label) => !label.startsWith("\\") && label.trim())
		.sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
	if (system.has("\\draft")) return { destination: null, userLabels: user.length };
	if (system.has("\\inbox")) return { destination: "system:inbox", userLabels: user.length };
	if (system.has("\\sent")) return { destination: "system:sent", userLabels: user.length };
	if (user.length) {
		const name = flattenFolderName({ name: user[0], delimiter: "/" });
		return { destination: `new:${name}`, userLabels: user.length };
	}
	return { destination: "system:archived", userLabels: 0 };
}

const ROLES = new Set<ImportFolderRole>(["inbox", "sent", "archive", "junk", "trash", "all", "user"]);
const SYSTEM_DESTINATIONS = /^system:(inbox|sent|archived|spam|trash)$/;

/**
 * The folders of a whole-account job request, checked: each a source name, a role and a destination
 * (`system:<status>`, `folder:<id>`, `new:<folder name>` or, for `all` only, `gmail:labels`). Only included rows are
 * kept, in the order given. Throws with a message for the user.
 */
export function parseAccountFolderRequest(value: unknown): AccountFolderRequest[] {
	if (!Array.isArray(value)) throw new Error("Choose the folders to import");
	if (value.length > MAX_ACCOUNT_FOLDERS) throw new Error(`An import can copy at most ${MAX_ACCOUNT_FOLDERS} folders`);
	const folders = (value as Record<string, unknown>[])
		.filter((entry) => entry && typeof entry === "object" && entry.include !== false)
		.map(parseFolderEntry);
	if (!folders.length) throw new Error("Choose at least one folder to import");
	return folders;
}

function parseFolderEntry(entry: Record<string, unknown>): AccountFolderRequest {
	const sourceName = typeof entry.sourceName === "string" ? entry.sourceName : "";
	const role = entry.role as ImportFolderRole;
	const destination = typeof entry.destination === "string" ? entry.destination.trim() : "";
	if (!sourceName || sourceName.length > 1000 || /[\r\n\0]/.test(sourceName))
		throw new Error("A source folder name is invalid");
	if (!ROLES.has(role)) throw new Error(`The folder ${sourceName} has no valid role`);
	const valid =
		SYSTEM_DESTINATIONS.test(destination) ||
		/^folder:[\w-]+$/.test(destination) ||
		/^new:.{1,80}$/su.test(destination) ||
		(destination === GMAIL_LABELS_DESTINATION && role === "all");
	if (!valid) throw new Error(`Choose where ${sourceName} goes`);
	const bytes = Number(entry.bytes);
	return { sourceName, role, destination, bytes: Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : null };
}
