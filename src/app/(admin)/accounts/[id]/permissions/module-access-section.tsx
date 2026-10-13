"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useCurrentUser } from "@/hooks/use-current-user";
import { authFetch } from "@/lib/auth/client";
import type { UserModuleAccessView } from "@/lib/modules/admin-types";
import type { ModuleId } from "@/lib/modules/module-types";
import { MODULES_QUERY_KEY } from "@/app/(admin)/modules/utils";

type Draft = Partial<Record<ModuleId, boolean>>;

async function readView(response: Response, fallback: string): Promise<UserModuleAccessView> {
	const json = (await response.json().catch(() => ({}))) as Partial<UserModuleAccessView> & { error?: string };
	if (!response.ok || !json.modules) throw new Error(json.error ?? fallback);
	return { migrationPending: !!json.migrationPending, modules: json.modules };
}

/**
 * The owner's per-user module access: each module is allowed or restricted for this account only.
 * Nothing renders for another admin, or for the owner's own account, which is never restricted.
 */
export function ModuleAccessSection({
	accountId,
	account,
}: {
	accountId: string;
	account: { isPrimaryAdmin?: boolean } | null;
}) {
	const viewer = useCurrentUser();
	if (!viewer?.isPrimaryAdmin || !account || account.isPrimaryAdmin) return null;
	return <ModuleAccessControls accountId={accountId} />;
}

function ModuleAccessControls({ accountId }: { accountId: string }) {
	const queryClient = useQueryClient();
	const [view, setView] = useState<UserModuleAccessView | null>(null);
	const [draft, setDraft] = useState<Draft>({});
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		void authFetch(`/api/admin/accounts/${accountId}/modules`)
			.then((response) => readView(response, "Unable to load module access"))
			.then((loaded) => active && setView(loaded))
			.catch((error) => active && setMessage(error instanceof Error ? error.message : "Unable to load module access"));
		return () => {
			active = false;
		};
	}, [accountId]);

	const changed = view?.modules.filter((entry) => draft[entry.id] !== undefined && draft[entry.id] !== entry.allowed);

	async function save() {
		if (!changed?.length) return;
		setSaving(true);
		setMessage(null);
		try {
			const response = await authFetch(`/api/admin/accounts/${accountId}/modules`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ access: Object.fromEntries(changed.map((entry) => [entry.id, draft[entry.id]])) }),
			});
			setView(await readView(response, "Unable to save module access"));
			// The root query client never refetches on mount, so a cached Modules page would keep the old per-user summary.
			queryClient.removeQueries({ queryKey: MODULES_QUERY_KEY });
			setDraft({});
			setMessage("Module access updated");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Unable to save module access");
		} finally {
			setSaving(false);
		}
	}

	return (
		<section aria-labelledby="module-access" className="space-y-4 rounded-3xl bg-white p-6">
			<div>
				<h2 id="module-access" className="text-sm font-semibold text-neutral-900">
					Modules
				</h2>
				<p className="mt-1 text-xs text-neutral-500">
					Choose which modules this account can use. A restricted account sees what everyone sees when the module is
					off. Booking also needs Calendar.
				</p>
			</div>
			{view?.migrationPending && (
				<p role="status" className="text-sm text-blue-900">
					Apply the pending database update to manage modules.
				</p>
			)}
			<ul className="divide-y divide-neutral-100">
				{view?.modules.map((entry) => (
					<li key={entry.id} className="flex items-center justify-between gap-4 py-3">
						<div className="min-w-0">
							<p className="text-sm font-semibold text-neutral-900">{entry.name}</p>
							<p className="mt-1 text-xs text-neutral-500">
								{entry.description}
								{!entry.installEnabled && " It is off for everyone."}
							</p>
						</div>
						<Checkbox
							aria-label={`Allow ${entry.name}`}
							checked={draft[entry.id] ?? entry.allowed}
							disabled={saving || view.migrationPending}
							onChange={(event) => setDraft((current) => ({ ...current, [entry.id]: event.target.checked }))}
						/>
					</li>
				))}
			</ul>
			<Button onClick={() => void save()} disabled={saving || !changed?.length}>
				{saving ? "Saving..." : "Save module access"}
			</Button>
			{message && <p className="text-sm text-neutral-500">{message}</p>}
		</section>
	);
}
