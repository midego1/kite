"use client";

import { useState } from "react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Button } from "@/components/ui/button";
import type { ExportState } from "./types";
import { exportMailbox } from "./utils";
import { PageHeader } from "@/components/ui/page";

export default function SettingsExportPage() {
	const { selectedMailbox } = useSelectedMailbox();
	const [exportState, setExportState] = useState<ExportState>({ error: null, loading: false });

	async function onExport() {
		if (!selectedMailbox?.id) return;
		setExportState({ error: null, loading: true });
		try {
			await exportMailbox(selectedMailbox.id, `${selectedMailbox.localPart}.mbox`);
		} catch (error) {
			setExportState({ error: error instanceof Error ? error.message : "Export failed", loading: false });
			return;
		}
		setExportState({ error: null, loading: false });
	}

	return (
		<div className="space-y-6">
			<PageHeader title="Export" description="Download mail from the currently selected mailbox." />

			<section className="space-y-4">
				<div>
					<h2 className="text-base font-semibold text-neutral-900">Export mailbox</h2>
					<p className="mt-1 text-sm text-neutral-500">
						Download message headers and bodies from the selected mailbox as an .mbox file. Attachments are not included
						in this export.
					</p>
				</div>
				<div className="space-y-3 rounded-xl border border-neutral-200 bg-white p-5">
					<Button type="button" variant="outline" disabled={!selectedMailbox || exportState.loading} onClick={onExport}>
						{exportState.loading ? "Preparing..." : "Download .mbox"}
					</Button>
					{exportState.error && (
						<p
							role="alert"
							className="rounded-lg border border-[#ef4444]/25 bg-[#ef4444]/10 text-[#b91c1c] dark:text-[#f19999] px-4 py-3 text-sm"
						>
							{exportState.error}
						</p>
					)}
				</div>
			</section>
		</div>
	);
}
