import type { AttachmentRisk } from "@/lib/email/attachment-risk-types";

/** A flagged file as the archive route lists it in its 409 answer. */
export type FlaggedArchiveFile = { id: string; filename: string; risk: AttachmentRisk };

/** The "Download all" archive route of a message, with `check=1` (checks only) or `acknowledge=1` when asked. */
export function attachmentsZipUrl(messageId: string, options: { check?: boolean; acknowledge?: boolean } = {}): string {
	const params = new URLSearchParams();
	if (options.check) params.set("check", "1");
	if (options.acknowledge) params.set("acknowledge", "1");
	const query = params.toString();
	return `/api/messages/${encodeURIComponent(messageId)}/attachments/zip${query ? `?${query}` : ""}`;
}

/** One line per flagged file for the confirmation: its name and the first reason it was flagged. */
export function flaggedArchiveLines(flagged: readonly FlaggedArchiveFile[]): string {
	return flagged
		.map((file) => (file.risk.reasons[0] ? `• ${file.filename}: ${file.risk.reasons[0]}` : `• ${file.filename}`))
		.join("\n");
}

/** Where the archive's check leads: download it, confirm the flagged files first, or explain why it cannot. */
export type ArchiveCheckOutcome =
	| { kind: "download" }
	| { kind: "confirm"; flagged: FlaggedArchiveFile[] }
	| { kind: "missing"; filenames: string[] }
	| { kind: "too-large" }
	| { kind: "failed" };

/** Reads the archive route's `check=1` answer. Anything unexpected counts as failed, never as a clean download. */
export function archiveCheckOutcome(status: number, body: unknown): ArchiveCheckOutcome {
	const data = (body && typeof body === "object" ? body : {}) as {
		flagged?: FlaggedArchiveFile[];
		missing?: { filename: string }[];
	};
	if (status === 200) return { kind: "download" };
	if (status === 409 && Array.isArray(data.flagged) && data.flagged.length)
		return { kind: "confirm", flagged: data.flagged };
	if (status === 404 && Array.isArray(data.missing))
		return { kind: "missing", filenames: data.missing.map((file) => file.filename) };
	if (status === 413) return { kind: "too-large" };
	return { kind: "failed" };
}
