"use client";

import { CARD_CLASS, TABLE_HEAD_CLASS } from "@/components/ui/page-utils";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { AccountPlan, AccountPlanFolder, ImportFolderSummary } from "./types";
import { formatPlannedBytes, systemDestinations } from "./utils";

type Props = {
	plan: AccountPlan;
	kiteFolders: ImportFolderSummary[];
	onChange: (folders: AccountPlanFolder[]) => void;
};

const roleLabels: Record<AccountPlanFolder["role"], string> = {
	inbox: "Inbox",
	sent: "Sent",
	archive: "Archive",
	junk: "Spam",
	trash: "Trash",
	all: "All Mail",
	user: "Folder",
};

/**
 * The mapping table of a whole-account import (spec §4.1): one row per source folder with a checkbox, its message
 * count and size, and where it goes in Kite. Every row can be changed before the import starts.
 */
export function AccountMappingTable({ plan, kiteFolders, onChange }: Props) {
	function update(index: number, change: Partial<AccountPlanFolder>) {
		onChange(plan.folders.map((folder, at) => (at === index ? { ...folder, ...change } : folder)));
	}

	return (
		<div className="space-y-2">
			{plan.gmail && (
				<p className="rounded-lg bg-neutral-50 px-4 py-3 text-xs leading-5 text-neutral-500">
					This is a Gmail account. Kite copies All Mail once and files each message by its labels: Inbox, then Sent,
					then its first label as a Kite folder, otherwise Archive. Drafts are left out.
				</p>
			)}
			<div className={`overflow-x-auto ${CARD_CLASS}`}>
				<table className="w-full text-left text-sm">
					<caption className="sr-only">Folders to import</caption>
					<thead className={TABLE_HEAD_CLASS}>
						<tr>
							<th scope="col" className="w-14 px-3 py-2">
								<span className="sr-only">Import</span>
							</th>
							<th scope="col" className="px-3 py-2 font-medium">
								Source folder
							</th>
							<th scope="col" className="px-3 py-2 text-right font-medium">
								Messages
							</th>
							<th scope="col" className="px-3 py-2 text-right font-medium">
								Size
							</th>
							<th scope="col" className="px-3 py-2 font-medium">
								Goes to
							</th>
						</tr>
					</thead>
					<tbody>
						{plan.folders.map((folder, index) => (
							<tr key={folder.sourceName} className="border-t border-neutral-200 first:border-t-0">
								<td className="px-3 py-2">
									<Switch
										aria-label={`Import ${folder.displayName}`}
										checked={folder.include}
										onCheckedChange={(include) => update(index, { include })}
									/>
								</td>
								<td className="px-3 py-2">
									<span className="font-medium text-neutral-900">{folder.displayName}</span>
									<span className="ml-2 text-xs text-neutral-500">{roleLabels[folder.role]}</span>
								</td>
								<td className="px-3 py-2 text-right tabular-nums text-neutral-700">
									{folder.messages === null ? "—" : folder.messages.toLocaleString("en-US")}
								</td>
								<td className="px-3 py-2 text-right tabular-nums text-neutral-700">
									{formatPlannedBytes(folder.bytes)}
								</td>
								<td className="min-w-48 px-3 py-2">
									<DestinationSelect
										folder={folder}
										kiteFolders={kiteFolders}
										onChange={(destination) => update(index, { destination })}
									/>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

function DestinationSelect({
	folder,
	kiteFolders,
	onChange,
}: {
	folder: AccountPlanFolder;
	kiteFolders: ImportFolderSummary[];
	onChange: (destination: string) => void;
}) {
	if (folder.role === "all") return <span className="text-sm text-neutral-700">By Gmail label</span>;
	const newFolder = `new:${folder.displayName}`;
	const existing = kiteFolders.find((kite) => kite.name.toLowerCase() === folder.displayName.toLowerCase());
	return (
		<Select
			aria-label={`Where ${folder.displayName} goes`}
			value={folder.destination}
			onChange={(event) => onChange(event.target.value)}
			className="w-full text-sm"
		>
			{systemDestinations.map((option) => (
				<option key={option.value} value={option.value}>
					{option.label}
				</option>
			))}
			{!existing && <option value={newFolder}>{`New folder: ${folder.displayName}`}</option>}
			{kiteFolders.map((kite) => (
				<option key={kite.id} value={`folder:${kite.id}`}>{`Folder: ${kite.name}`}</option>
			))}
		</Select>
	);
}
