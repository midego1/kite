import { type DatabaseUseLevel, databaseUseLevel } from "@/lib/db/size-utils";

/** D1 bytes per message assumed for an install with too few messages to measure its own average. */
const DEFAULT_DATABASE_BYTES_PER_MESSAGE = 40_000;
/** An install needs this many messages before its own average is trusted. */
const MIN_MESSAGES_FOR_AVERAGE = 1000;
/** The most D1 one imported message is assumed to add. */
const MAX_DATABASE_BYTES_PER_MESSAGE = 128 * 1024;
/** The same, once HTML bodies over 16 KB are kept in the mail store instead of D1. */
const MAX_DATABASE_BYTES_PER_MESSAGE_OFFLOADED = 24 * 1024;
/** Raw MIME plus the decoded attachment copy (1.0 once attachments are stored once). */
const MAIL_STORE_FACTOR = 1.75;

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
		mailStoreBytes: rawBytes === null ? null : Math.round(rawBytes * MAIL_STORE_FACTOR),
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
