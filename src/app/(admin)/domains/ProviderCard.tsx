import type { ReactNode } from "react";
import { AlertTriangle, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

type Props = {
	title: string;
	description: string;
	/** true = set up, false = needs setup, null = unknown or not applicable (no icon). */
	ok: boolean | null;
	selected: boolean;
	disabled?: boolean;
	onToggle: (on: boolean) => void;
	/** Configuration shown while the option is selected. */
	children?: ReactNode;
	/** Shown on an unselected option that still has configuration. */
	cleanup?: { present: boolean; busy: boolean; disabled?: boolean; onClick: () => void } | null;
};

/** One selectable provider: icon-left header with a switch, its config when on, a clean-up bar when off but configured. */
export default function ProviderCard({
	title,
	description,
	ok,
	selected,
	disabled,
	onToggle,
	children,
	cleanup,
}: Props) {
	return (
		<li className="rounded-xl bg-neutral-50 px-4 py-3 text-sm">
			<div className="flex items-center justify-between gap-3">
				{ok !== null &&
					(ok ? (
						<span
							title="Set up"
							className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-green-600 text-white"
						>
							<Check className="h-4 w-4" />
						</span>
					) : (
						<span
							title="Needs setup"
							className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-100"
						>
							<AlertTriangle className="h-4 w-4 text-amber-600" />
						</span>
					))}
				<span className="min-w-0 flex-1">
					<span className="block font-medium text-neutral-900">{title}</span>
					<span className="block text-xs text-neutral-500">{description}</span>
				</span>
				<Switch aria-label={title} checked={selected} disabled={disabled} onCheckedChange={onToggle} />
			</div>
			{selected && children && <div className="mt-3 border-t border-neutral-200 pt-3">{children}</div>}
			{!selected && cleanup?.present && (
				<div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-neutral-200 pt-3 text-xs text-neutral-500">
					<span>{title} is still set up for this domain but not used.</span>
					<Button
						size="sm"
						variant="outline"
						className="bg-white"
						disabled={cleanup.busy || cleanup.disabled}
						onClick={cleanup.onClick}
					>
						{cleanup.busy ? "Removing…" : "Clean up"}
					</Button>
				</div>
			)}
		</li>
	);
}
