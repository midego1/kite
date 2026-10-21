"use client";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { SkipDnsSwitchProps } from "./skip-dns-switch-types";

/** The "Skip DNS setup" choice shared by the add-domain dialog, onboarding and first-run registration. */
export function SkipDnsSwitch({ id, checked, onCheckedChange, disabled, className }: SkipDnsSwitchProps) {
	const hintId = `${id}-hint`;
	return (
		<div className={cn("space-y-2", className)}>
			<div className="flex items-center justify-between gap-4 rounded-2xl bg-neutral-50 px-4 py-3">
				<div>
					<Label htmlFor={id}>Skip DNS setup</Label>
					<p id={hintId} className="mt-1 text-xs leading-5 text-neutral-500">
						Add the domain now and set up DNS records later
					</p>
				</div>
				<Switch
					id={id}
					checked={checked}
					onCheckedChange={onCheckedChange}
					disabled={disabled}
					aria-describedby={hintId}
				/>
			</div>
			{checked && (
				<p className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900">
					Kite will not check or change DNS. Mail will not arrive until the records are set.
				</p>
			)}
		</div>
	);
}
