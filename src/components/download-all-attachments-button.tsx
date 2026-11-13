"use client";

import { ArrowDownToLine } from "lucide-react";
import { useState } from "react";
import toast from "react-hot-toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { authFetch } from "@/lib/auth/client";
import { useT } from "@/lib/i18n/use-t";
import { archiveCheckOutcome, attachmentsZipUrl, flaggedArchiveLines } from "./download-all-attachments-utils";

/** Starts a download without leaving the page: the route answers with `Content-Disposition: attachment`. */
function startDownload(url: string) {
	const link = document.createElement("a");
	link.href = url;
	link.download = "";
	link.rel = "noopener";
	document.body.appendChild(link);
	link.click();
	link.remove();
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

	async function downloadAll() {
		setBusy(true);
		try {
			const response = await authFetch(attachmentsZipUrl(messageId, { check: true }));
			const outcome = archiveCheckOutcome(response.status, await response.json().catch(() => null));
			if (outcome.kind === "download") return startDownload(attachmentsZipUrl(messageId));
			if (outcome.kind === "confirm") {
				const confirmed = await confirm({
					title: t("Download flagged files?"),
					description: `${t("{count, plural, one {# file is} other {# files are}} flagged as risky:", { count: outcome.flagged.length })}\n${flaggedArchiveLines(outcome.flagged)}\n\n${t("Open them only if you expected them from someone you trust.")}`,
					confirmLabel: t("Download all"),
				});
				if (confirmed) startDownload(attachmentsZipUrl(messageId, { acknowledge: true }));
				return;
			}
			if (outcome.kind === "missing")
				toast.error(t("Some attachments are missing from storage: {names}", { names: outcome.filenames.join(", ") }));
			else if (outcome.kind === "too-large") toast.error(t("These attachments are too large to download together."));
			else toast.error(t("The attachments could not be downloaded."));
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
