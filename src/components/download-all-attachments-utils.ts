import { stripHiddenCharacters } from "@/lib/email/attachment-risk";
import type { AttachmentRisk } from "@/lib/email/attachment-risk-types";

/** A flagged file as the archive route lists it in its 409 answer. */
type FlaggedArchiveFile = { id: string; filename: string; risk: AttachmentRisk };

/** The "Download all" archive route of a message, with `check=1` (checks only) or `acknowledge=1` when asked. */
export function attachmentsZipUrl(messageId: string, options: { check?: boolean; acknowledge?: boolean } = {}): string {
	const params = new URLSearchParams();
	if (options.check) params.set("check", "1");
	if (options.acknowledge) params.set("acknowledge", "1");
	const query = params.toString();
	return `/api/messages/${encodeURIComponent(messageId)}/attachments/zip${query ? `?${query}` : ""}`;
}

/**
 * One line per flagged file for the confirmation: its name and the first reason it was flagged, without control or
 * bidi characters, so a name cannot reorder itself in the very warning about it.
 */
export function flaggedArchiveLines(flagged: readonly FlaggedArchiveFile[]): string {
	return flagged
		.map((file) => {
			const reason = file.risk.reasons[0];
			return stripHiddenCharacters(reason ? `• ${file.filename}: ${reason}` : `• ${file.filename}`);
		})
		.join("\n");
}

/** Where the archive's check leads: download it, confirm the flagged files first, or explain why it cannot. */
type ArchiveCheckOutcome =
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
		return { kind: "missing", filenames: data.missing.map((file) => stripHiddenCharacters(String(file.filename))) };
	if (status === 413) return { kind: "too-large" };
	return { kind: "failed" };
}

const REFUSAL_STATUS: Record<string, number> = { ATTACHMENT_MISSING: 404, ATTACHMENT_RISK: 409, TOO_LARGE: 413 };

/**
 * What a refused download says, read from the error the hidden download frame loaded instead of starting a download
 * (the frame cannot see the status, so the route's `code` stands in for it). Anything else is a plain failure.
 */
export function archiveFrameOutcome(text: string): ArchiveCheckOutcome {
	let body: unknown = null;
	try {
		body = JSON.parse(text);
	} catch {
		return { kind: "failed" };
	}
	const code = body && typeof body === "object" ? (body as { code?: unknown }).code : undefined;
	const status = typeof code === "string" ? REFUSAL_STATUS[code] : undefined;
	if (!status || status === 409) return { kind: "failed" };
	return archiveCheckOutcome(status, body);
}
