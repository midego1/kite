"use client";

import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { importMessageFiles } from "@/components/settings/import-messages-utils";
import { ImportJobsPanel } from "@/components/settings/import-jobs-panel";
import { ImapImportForm } from "./imap-import-form";
import type { ImportResult, ImportSourceItem, ImportSourceSection, ImportTab, ImportProgress } from "./types";
import {
	ensureImportDestination,
	formatImportResult,
	getFileImportSource,
	getSelectedImportSources,
	importSourceOptions,
} from "./utils";
import { FieldHint, FormError, PageHeader, SettingsCard, SettingsCardSection } from "@/components/ui/page";

const defaultSections = importSourceOptions.map((option) => option.value);

export default function SettingsImportPage() {
	const { selectedMailbox } = useSelectedMailbox();
	const [activeTab, setActiveTab] = useState<ImportTab>("file");
	const [selectedSections, setSelectedSections] = useState<ImportSourceSection[]>(defaultSections);
	const [files, setFiles] = useState<File[]>([]);
	const [fileResult, setFileResult] = useState<ImportResult | null>(null);
	const [fileError, setFileError] = useState<string | null>(null);
	const [fileLoading, setFileLoading] = useState(false);
	const [fileProgress, setFileProgress] = useState<ImportProgress | null>(null);
	const [jobsRefreshKey, setJobsRefreshKey] = useState(0);
	const selectedSources = useMemo(() => getSelectedImportSources(selectedSections), [selectedSections]);
	const fileImportSource = getFileImportSource(selectedSources);

	function toggleSection(section: ImportSourceSection, checked: boolean) {
		setSelectedSections((current) => {
			if (checked) return current.includes(section) ? current : [...current, section];
			return current.filter((item) => item !== section);
		});
	}

	async function getDestination(source: ImportSourceItem): Promise<string> {
		if (!selectedMailbox?.id) throw new Error("Select a mailbox first");
		return ensureImportDestination(selectedMailbox.id, source);
	}

	async function onFileSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!selectedMailbox?.id || selectedSources.length === 0) return;

		setFileLoading(true);
		setFileError(null);
		setFileResult(null);
		setFileProgress({ completed: 0, total: 100, label: "Preparing files" });
		try {
			const destination = await getDestination(fileImportSource);
			const result = await importMessageFiles(selectedMailbox.id, files, destination, (percentage) =>
				setFileProgress({
					completed: percentage,
					total: 100,
					label: percentage < 70 ? "Uploading files" : "Importing messages",
				}),
			);
			setFileResult(result);
			window.dispatchEvent(new Event("kite:messages-changed"));
		} catch (error) {
			setFileError(error instanceof Error ? error.message : "File import failed");
		} finally {
			setFileLoading(false);
		}
	}

	return (
		<div className="space-y-6">
			<PageHeader
				title="Import"
				description="Bring mail from a backup file or another mail server into the inbox selected in the sidebar."
			/>

			<SettingsCard>
				<SettingsCardSection title="Source" description="What to import and how Kite should receive it.">
					<div className="space-y-5">
						<div className="flex flex-col gap-2">
							<Label htmlFor="import-source">Import from</Label>
							<Select
								id="import-source"
								value={activeTab}
								onChange={(event) => setActiveTab(event.target.value as ImportTab)}
								className="text-sm w-full py-2"
							>
								<option value="file">Backup file</option>
								<option value="imap">IMAP</option>
							</Select>
						</div>
						{activeTab === "file" ? (
							<form onSubmit={onFileSubmit} className="space-y-5">
								<fieldset className="space-y-2">
									<legend className="text-sm font-medium text-neutral-900">Sections to import</legend>
									<div className="grid gap-2 lg:grid-cols-2">
										{importSourceOptions.map((option) => (
											<label key={option.value} className="flex items-center gap-3 text-sm text-neutral-700">
												<Checkbox
													checked={selectedSections.includes(option.value)}
													onChange={(event) => toggleSection(option.value, event.target.checked)}
												/>
												{option.label}
											</label>
										))}
									</div>
								</fieldset>
								<div className="space-y-2">
									<Label htmlFor="import-files">Backup files</Label>
									<Input
										id="import-files"
										type="file"
										accept=".eml,.mbox,.mbx,message/rfc822,application/mbox"
										multiple
										onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
										aria-describedby="import-files-hint"
										className="block w-full rounded-md border border-neutral-200 bg-white px-3 py-1 text-sm shadow-sm shadow-neutral-200/50 file:mr-3 file:rounded-md file:border-0 file:bg-neutral-100 file:px-3 file:py-1.5 file:text-sm file:font-medium"
									/>
									<FieldHint id="import-files-hint">
										Files are imported into {fileImportSource.label}. Read and starred state is taken from each
										message&apos;s headers. For Inbox, mail the export marks as Spam or Trash (Gmail Takeout labels,
										X-Spam-Flag) is filed there instead; choose Archive or a folder to keep everything in place.
									</FieldHint>
								</div>
								{selectedSections.includes("others") && (
									<p className="rounded-lg border border-[#f59e0b]/25 bg-[#f59e0b]/10 text-[#8a4b0a] dark:text-[#d4a35a] px-4 py-3 text-sm">
										Other folders can be imported automatically from IMAP. File import cannot discover which section a
										message belongs to, apart from the Spam and Trash hints in its headers.
									</p>
								)}
								<Button
									type="submit"
									disabled={!selectedMailbox || selectedSources.length === 0 || files.length === 0 || fileLoading}
								>
									{fileLoading ? "Importing..." : "Import selected files"}
								</Button>
								{fileProgress && (
									<div className="space-y-1 text-xs text-neutral-500" aria-live="polite">
										<div className="flex justify-between">
											<span>{fileProgress.label}</span>
											<span>{fileProgress.completed}%</span>
										</div>
										<div className="h-1.5 overflow-hidden rounded-full bg-neutral-100">
											<div
												className="h-full bg-blue-600 transition-[width]"
												style={{ width: `${fileProgress.completed}%` }}
											/>
										</div>
									</div>
								)}
								{fileResult && (
									<p className="rounded-lg border border-[#22c55e]/25 bg-[#22c55e]/10 text-[#166534] dark:text-[#86c99d] px-4 py-3 text-sm">
										{formatImportResult(fileResult)}
									</p>
								)}
								{fileError && <FormError>{fileError}</FormError>}
							</form>
						) : (
							<ImapImportForm
								mailboxId={selectedMailbox?.id ?? null}
								onStarted={() => setJobsRefreshKey((key) => key + 1)}
							/>
						)}
					</div>
				</SettingsCardSection>
			</SettingsCard>
			<ImportJobsPanel refreshKey={jobsRefreshKey} />
		</div>
	);
}
