"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useInvalidateAuthMe } from "@/hooks/use-auth-me";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { ModuleAdminEntry, ModuleAdminView } from "@/lib/modules/admin-types";
import { turnOffWarning } from "@/lib/modules/admin-utils";
import { ModuleCard } from "./module-card";
import { fetchModuleAdminView, MODULES_QUERY_KEY, saveModuleEnabled } from "./utils";

const CORE_AREAS =
	"Mail, mailboxes, domains, contacts, accounts, settings, backups, search, the assistant, MCP, the API, JMAP, webhooks and mailbox export are always on and have no switch.";

export default function ModulesPage() {
	const queryClient = useQueryClient();
	const confirm = useConfirm();
	const invalidateSession = useInvalidateAuthMe();
	const modules = useQuery({ queryKey: MODULES_QUERY_KEY, queryFn: fetchModuleAdminView });
	const [busy, setBusy] = useState(false);
	const [errors, setErrors] = useState<Record<string, string>>({});

	async function toggle(entry: ModuleAdminEntry, enabled: boolean) {
		const view = modules.data;
		if (!view) return;
		setErrors((current) => ({ ...current, [entry.id]: "" }));
		if (!enabled && entry.dependents.length) {
			const confirmed = await confirm({
				title: `Turn off ${entry.name}?`,
				description: turnOffWarning(entry, view.modules),
				confirmLabel: `Turn off ${entry.name}`,
				destructive: false,
			});
			if (!confirmed) return;
		}
		setBusy(true);
		try {
			const next: ModuleAdminView = await saveModuleEnabled(entry.id, enabled);
			queryClient.setQueryData(MODULES_QUERY_KEY, next);
			void invalidateSession();
		} catch (error) {
			setErrors((current) => ({
				...current,
				[entry.id]: error instanceof Error ? error.message : "Unable to change the module",
			}));
		} finally {
			setBusy(false);
		}
	}

	const view = modules.data;
	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl md:text-3xl font-medium text-neutral-900">Modules</h1>
				<p className="mt-2 text-sm text-neutral-500">
					Turn optional parts of Kite on or off for everyone. Turning a module off hides it and removes what it adds,
					and keeps its data.
				</p>
				<p className="mt-1 text-sm text-neutral-500">
					A change can take up to 30 seconds to reach other open sessions.
				</p>
			</div>
			{view?.migrationPending && (
				<p role="status" className="rounded-3xl bg-blue-50 p-6 text-sm font-medium text-blue-900">
					Apply the pending database update to manage modules. Every module stays on until then.
				</p>
			)}
			{modules.isError && (
				<p role="alert" className="text-sm text-red-600">
					{modules.error instanceof Error ? modules.error.message : "Failed to load modules"}
				</p>
			)}
			{modules.isLoading &&
				Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-40 w-full rounded-3xl" />)}
			{view?.modules.map((entry) => (
				<ModuleCard
					key={entry.id}
					entry={entry}
					disabled={busy || view.migrationPending}
					error={errors[entry.id] || null}
					onToggle={(item, enabled) => void toggle(item, enabled)}
				/>
			))}
			<section aria-labelledby="core-areas" className="rounded-3xl bg-white p-6">
				<h2 id="core-areas" className="text-lg font-semibold text-neutral-900">
					Always on
				</h2>
				<p className="mt-1 text-sm text-neutral-500">{CORE_AREAS}</p>
			</section>
		</div>
	);
}
