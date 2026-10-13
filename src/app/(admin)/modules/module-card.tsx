import { Switch } from "@/components/ui/switch";
import type { ModuleAdminEntry } from "@/lib/modules/admin-types";
import { accessSummary } from "@/lib/modules/admin-utils";
import { ModuleCapabilities } from "./module-capabilities";

type ModuleCardProps = {
	entry: ModuleAdminEntry;
	disabled: boolean;
	error: string | null;
	onToggle: (entry: ModuleAdminEntry, enabled: boolean) => void;
};

function statusText(entry: ModuleAdminEntry): string {
	if (entry.offBecause) return `Off because ${entry.offBecause.name} is off`;
	return entry.effective ? "On" : "Off";
}

export function ModuleCard({ entry, disabled, error, onToggle }: ModuleCardProps) {
	const headingId = `module-${entry.id}`;
	const blocked = entry.offBecause;
	return (
		<section aria-labelledby={headingId} data-module={entry.id} className="space-y-4 rounded-3xl bg-white p-6">
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0">
					<h2 id={headingId} className="text-lg font-semibold text-neutral-900">
						{entry.name}
					</h2>
					<p className="mt-1 text-sm text-neutral-500">{entry.description}</p>
				</div>
				<div className="flex shrink-0 items-center gap-3">
					<span
						className={`text-xs font-semibold ${entry.effective ? "text-blue-600" : "text-neutral-500"}`}
						data-testid={`${entry.id}-status`}
					>
						{statusText(entry)}
					</span>
					<Switch
						aria-label={`${entry.name} module`}
						checked={entry.effective}
						disabled={disabled}
						onCheckedChange={(next) => onToggle(entry, next)}
					/>
				</div>
			</div>
			{entry.dependsOn.length > 0 && (
				<p className="text-sm text-neutral-700">
					Depends on {entry.dependsOn.map((dependency) => dependency.name).join(" and ")}.
					{blocked &&
						(entry.enabled
							? ` Its own setting is on, and it comes back when ${blocked.name} is turned on.`
							: ` Turn on ${blocked.name} first.`)}
				</p>
			)}
			{error && (
				<p role="alert" className="text-sm text-red-600">
					{error}
				</p>
			)}
			{entry.adminNotes.map((note) => (
				<p key={note} className="rounded-2xl bg-blue-50 px-4 py-3 text-sm text-blue-900">
					{note}
				</p>
			))}
			<ModuleCapabilities capabilities={entry.capabilities} />
			<p className="text-sm text-neutral-500">
				<span className="font-semibold text-neutral-700">User access:</span> {accessSummary(entry)}
			</p>
		</section>
	);
}
