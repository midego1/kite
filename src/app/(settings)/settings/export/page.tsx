"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Button } from "@/components/ui/button";
import type { ExportState } from "./types";
import { exportMailbox } from "./utils";
import { FormError, FormFooter, PageHeader, SettingsCard, SettingsCardSection } from "@/components/ui/page";

export default function SettingsExportPage() {
	const { selectedMailbox } = useSelectedMailbox();
	const [exportState, setExportState] = useState<ExportState>({ error: null, loading: false });
	const address = selectedMailbox ? `${selectedMailbox.localPart}@${selectedMailbox.hostname}` : null;

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
			<PageHeader title="Export" description="Download the mail of the inbox selected in the sidebar." />
			<SettingsCard>
				<SettingsCardSection
					title={address ? `Export ${address}` : "Export mailbox"}
					description="One .mbox file with every message's headers and body, which other mail apps can open. Attachments are not included."
				>
					<FormFooter>
						<Button
							type="button"
							variant="outline"
							disabled={!selectedMailbox || exportState.loading}
							onClick={onExport}
						>
							<Download className="h-4 w-4" />
							{exportState.loading ? "Preparing..." : "Download .mbox"}
						</Button>
					</FormFooter>
					{exportState.error && <FormError className="mt-3">{exportState.error}</FormError>}
				</SettingsCardSection>
			</SettingsCard>
		</div>
	);
}
