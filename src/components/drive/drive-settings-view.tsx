"use client";

import { useState } from "react";
import { DirectUploadsTip } from "./direct-uploads-tip";
import { DriveSettingsForm } from "./drive-settings-form";
import { DriveUsageTable } from "./drive-usage-table";

/** Admin → Drive: install defaults and every account's usage. On or off stays on Admin → Modules. */
export function DriveSettingsView() {
	const [reloadKey, setReloadKey] = useState(0);
	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-xl font-semibold tracking-tight text-neutral-900">Drive</h1>
				<p className="mt-1 text-sm text-neutral-500">
					Set how much each account can store, how long public links may last and how long the trash keeps files. Turn
					Drive on or off for everyone under Modules, and for one account under Accounts → Permissions.
				</p>
			</div>
			<DirectUploadsTip />
			<DriveSettingsForm onSaved={() => setReloadKey((key) => key + 1)} />
			<DriveUsageTable reloadKey={reloadKey} />
		</div>
	);
}
