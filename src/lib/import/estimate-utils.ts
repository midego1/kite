import { type DatabaseUseLevel, databaseUseLevel } from "@/lib/db/size-utils";

/** D1 bytes per message assumed for an install with too few messages to measure its own average. */
const DEFAULT_DATABASE_BYTES_PER_MESSAGE = 40_000;
/** An install needs this many messages before its own average is trusted. */
const MIN_MESSAGES_FOR_AVERAGE = 1000;
/** The most D1 one imported message is assumed to add. */
const MAX_DATABASE_BYTES_PER_MESSAGE = 128 * 1024;
/** The same, once HTML bodies over 16 KB are kept in the mail store instead of D1. */
const MAX_DATABASE_BYTES_PER_MESSAGE_OFFLOADED = 24 * 1024;
/**
 * Mail store bytes per byte of source mail: the raw message is written once (`imports/<id>.eml`) and its verified
 * attachments are 'raw' rows pointing into it, with no decoded copy (`docs/specs/attachments-once.md`).
 * A body offloaded to the mail store (HTML over 16 KB, when body offload is on) adds its decoded HTML as one more object.
 * That share depends on the mail and nothing here measures it, so it is left out.
 */
export const MAIL_STORE_FACTOR = 1;
/**
 * The same with `ATTACHMENT_RAW_INDEX=off`: every attachment is stored again, decoded. The spec measured 1.51 GB per GB
 * of mail, assuming attachments are 70% of the raw bytes and base64 decodes to 0.731 of its size.
 */
export const MAIL_STORE_FACTOR_WITHOUT_RAW_INDEX = 1.51;

export type ImportEstimateInput = {
	/** Messages the import will read; null while the source cannot say. */
	messages: number | null;
	/** Sum of the source's `RFC822.SIZE` for them; null when the sizes are not known. */
	rawBytes: number | null;
	usedBytes: number;
	limitBytes: number | null;
	/** `count(messages)` of the install, for its own average. */
	installMessageCount: number;
	bodyOffload?: boolean;
	/** `ATTACHMENT_RAW_INDEX` is on (the default): attachments live inside the raw message and are not stored again. */
	rawIndex?: boolean;
};

export type ImportEstimate = {
	messages: number | null;
	rawBytes: number | null;
	/** Null when the raw sizes are not known. */
	mailStoreBytes: number | null;
	databaseBytesPerMessage: number;
	/** What the import adds to the database; 0 while the message count is unknown. */
	databaseAddBytes: number;
	usedBytes: number;
	projectedBytes: number;
	limitBytes: number | null;
	currentLevel: DatabaseUseLevel;
	projectedLevel: DatabaseUseLevel;
	/** The import needs an explicit "Import anyway": the database is or would be above 90% of its limit. */
	requiresConfirmation: boolean;
};

/** The install's average D1 bytes per message, or the default while it holds too few to measure. */
function averageDatabaseBytesPerMessage(usedBytes: number, installMessageCount: number): number {
	return installMessageCount >= MIN_MESSAGES_FOR_AVERAGE && usedBytes > 0
		? usedBytes / installMessageCount
		: DEFAULT_DATABASE_BYTES_PER_MESSAGE;
}

export function estimateImport(input: ImportEstimateInput): ImportEstimate {
	const messages = input.messages === null ? null : Math.max(0, Math.floor(input.messages));
	const rawBytes = input.rawBytes !== null && input.rawBytes >= 0 ? Math.floor(input.rawBytes) : null;
	const cap = input.bodyOffload ? MAX_DATABASE_BYTES_PER_MESSAGE_OFFLOADED : MAX_DATABASE_BYTES_PER_MESSAGE;
	let perMessage = Math.min(averageDatabaseBytesPerMessage(input.usedBytes, input.installMessageCount), cap);
	// A message cannot add more than it weighs; the totals give the average weight.
	if (messages && rawBytes !== null) perMessage = Math.min(perMessage, rawBytes / messages);
	const databaseAddBytes = messages ? Math.round(messages * perMessage) : 0;
	const projectedBytes = input.usedBytes + databaseAddBytes;
	const currentLevel = databaseUseLevel(input.usedBytes, input.limitBytes);
	const projectedLevel = databaseUseLevel(projectedBytes, input.limitBytes);
	return {
		messages,
		rawBytes,
		mailStoreBytes:
			rawBytes === null
				? null
				: Math.round(rawBytes * (input.rawIndex === false ? MAIL_STORE_FACTOR_WITHOUT_RAW_INDEX : MAIL_STORE_FACTOR)),
		databaseBytesPerMessage: Math.round(perMessage),
		databaseAddBytes,
		usedBytes: input.usedBytes,
		projectedBytes,
		limitBytes: input.limitBytes,
		currentLevel,
		projectedLevel,
		requiresConfirmation: projectedLevel === "critical",
	};
}

/** One line for the import page, as in the spec: "About 48,000 messages, … Adds about 1.9 GB …". */
export function describeImportEstimate(
	estimate: ImportEstimate,
	format: (bytes: number) => string,
): { summary: string; level: DatabaseUseLevel } {
	const now = `${format(estimate.usedBytes)}${estimate.limitBytes ? ` of ${format(estimate.limitBytes)}` : ""}`;
	if (!estimate.messages) return { summary: `The database is now ${now}.`, level: estimate.projectedLevel };
	const count = `${estimate.messages.toLocaleString("en-US")} message${estimate.messages === 1 ? "" : "s"}`;
	const mail = estimate.rawBytes === null ? "" : `, ${format(estimate.rawBytes)} of mail`;
	const store = estimate.mailStoreBytes === null ? "" : ` and ${format(estimate.mailStoreBytes)} to mail storage`;
	return {
		summary: `About ${count}${mail}. Adds about ${format(estimate.databaseAddBytes)} to the database (now ${now})${store}.`,
		level: estimate.projectedLevel,
	};
}

/** How well the source's size is known: summed from the server's own totals, extrapolated from part of it, or not at all. */
export type SourceSizeKind = "exact" | "estimated" | "unknown";

export type ImportTotalRow = { key: "messages" | "source" | "mail-store" | "database"; label: string; value: string };

/**
 * The always-visible totals of an import: messages, source size, and what the import adds to the mail store and to the
 * database. A size that is only an estimate says so; sums are upper bounds either way, because mail that is already in
 * Kite or sits in several folders is copied once (the page says that next to the rows). `estimate` is null while the
 * server could not read the database size: the mail store and database rows then wait.
 */
export function importTotalRows(
	totals: { messages: number | null; rawBytes: number | null },
	estimate: ImportEstimate | null,
	format: (bytes: number) => string,
	sourceSize: SourceSizeKind,
): ImportTotalRow[] {
	const about = sourceSize === "exact" ? "" : "about ";
	const known = totals.rawBytes !== null && sourceSize !== "unknown";
	const rows: ImportTotalRow[] = [];
	if (totals.messages !== null)
		rows.push({ key: "messages", label: "Messages", value: totals.messages.toLocaleString("en-US") });
	rows.push({
		key: "source",
		label: "Size at the source",
		value: known
			? `${about}${format(totals.rawBytes!)}${sourceSize === "estimated" ? " (estimate)" : ""}`
			: "Not known yet",
	});
	if (estimate?.mailStoreBytes != null && known)
		rows.push({
			key: "mail-store",
			label: "Adds to mail storage",
			value: `${about}${format(estimate.mailStoreBytes)}`,
		});
	if (estimate?.messages)
		rows.push({
			key: "database",
			label: "Adds to the database",
			value: `about ${format(estimate.databaseAddBytes)} (now ${format(estimate.usedBytes)}${estimate.limitBytes ? ` of ${format(estimate.limitBytes)}` : ""})`,
		});
	return rows;
}
