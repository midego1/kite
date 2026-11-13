"use client";

import { ArrowDownToLine } from "lucide-react";
import { useState } from "react";
import toast from "react-hot-toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { authFetch } from "@/lib/auth/client";
import { useT } from "@/lib/i18n/use-t";
import {
	archiveCheckOutcome,
	archiveFrameOutcome,
	attachmentsZipUrl,
	flaggedArchiveLines,
} from "./download-all-attachments-utils";

/** How long the hidden frame stays: long enough for the archive's response headers to arrive on a slow server. */
const FRAME_LIFETIME_MS = 10 * 60_000;

/**
 * Starts the download in a hidden same-origin frame, so the page stays put. The archive (`Content-Disposition:
 * attachment`) becomes a download and loads nothing; an error loads into the frame instead, and `onRefused` gets its
 * text, so a refusal between the check and the download (an expired session, a file gone meanwhile) is reported
 * instead of being saved as a file.
 */
function startDownload(url: string, onRefused: (text: string) => void) {
	const frame = document.createElement("iframe");
	frame.hidden = true;
	frame.tabIndex = -1;
	frame.setAttribute("aria-hidden", "true");
	frame.addEventListener(
		"load",
		() => {
			let text = "";
			try {
				const page = frame.contentDocument;
				if (page?.location.href === "about:blank") return;
				text = page?.querySelector("pre")?.textContent ?? page?.body?.textContent ?? "";
			} catch {
				// An unreadable page is still a page instead of a download.
			}
			onRefused(text);
			frame.remove();
		},
		{ once: true },
	);
	frame.src = url;
	document.body.appendChild(frame);
	window.setTimeout(() => frame.remove(), FRAME_LIFETIME_MS);
}

/**
 * "Download all" for a message's attachments: one ZIP streamed by the server. It checks first, so a flagged file asks
 * for the same confirmation as its single download, and a file missing from storage is reported instead of being left
 * out of the archive.
 */
export function DownloadAllAttachmentsButton({ messageId }: { messageId: string }) {
	const t = useT();
	const confirm = useConfirm();
	const [busy, setBusy] = useState(false);

	function report(outcome: ReturnType<typeof archiveCheckOutcome>) {
		if (outcome.kind === "missing")
			toast.error(t("Some attachments are missing from storage: {names}", { names: outcome.filenames.join(", ") }));
		else if (outcome.kind === "too-large") toast.error(t("These attachments are too large to download together."));
		else toast.error(t("The attachments could not be downloaded."));
	}

	/**
	 * The download itself carries `acknowledge=1`: the check just passed with nothing flagged, or the reader confirmed
	 * the flagged files, so the route need not assess every file again.
	 */
	function download() {
		startDownload(attachmentsZipUrl(messageId, { acknowledge: true }), (text) => report(archiveFrameOutcome(text)));
	}

	async function downloadAll() {
		setBusy(true);
		try {
			const response = await authFetch(attachmentsZipUrl(messageId, { check: true }));
			const outcome = archiveCheckOutcome(response.status, await response.json().catch(() => null));
			if (outcome.kind === "download") return download();
			if (outcome.kind === "confirm") {
				const confirmed = await confirm({
					title: t("Download flagged files?"),
					description: `${t("{count, plural, one {# file is} other {# files are}} flagged as risky:", { count: outcome.flagged.length })}\n${flaggedArchiveLines(outcome.flagged)}\n\n${t("Open them only if you expected them from someone you trust.")}`,
					confirmLabel: t("Download all"),
				});
				if (confirmed) download();
				return;
			}
			report(outcome);
		} catch {
			toast.error(t("The attachments could not be downloaded."));
		} finally {
			setBusy(false);
		}
	}

	return (
		<button
			type="button"
			onClick={() => void downloadAll()}
			disabled={busy}
			aria-busy={busy || undefined}
			className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-50"
		>
			<ArrowDownToLine className="h-3.5 w-3.5" aria-hidden="true" />
			{t("Download all")}
		</button>
	);
}
