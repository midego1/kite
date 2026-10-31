"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { DriveCrumb } from "@/lib/drive/types";
import { FolderPicker } from "./folder-picker";

/**
 * Pick a folder of your own and act on it: Move and Save to Drive. `onChoose` gets the folder (null for
 * My Drive) and throws with the message to show when it fails; the dialog closes when it succeeds.
 */
export function FolderChoiceDialog({
	open,
	onOpenChange,
	title,
	description,
	verb,
	exclude,
	notice,
	chooseDisabled = false,
	onChoose,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: string;
	verb: string;
	exclude?: ReadonlySet<string>;
	/** Shown above the buttons, such as the risk warning of a flagged attachment. */
	notice?: ReactNode;
	chooseDisabled?: boolean;
	onChoose: (folder: DriveCrumb | null) => Promise<void>;
}) {
	const [trail, setTrail] = useState<DriveCrumb[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const current = trail.at(-1) ?? null;

	function close(next: boolean) {
		if (busy) return;
		if (!next) {
			setTrail([]);
			setError(null);
		}
		onOpenChange(next);
	}

	async function choose() {
		setBusy(true);
		setError(null);
		try {
			await onChoose(current);
			setBusy(false);
			close(false);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Something went wrong");
			setBusy(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto sm:max-w-md" data-drive-folder-dialog>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<FolderPicker trail={trail} onTrailChange={setTrail} active={open} exclude={exclude} />
				{notice}
				{error && (
					<p role="alert" className="text-sm text-red-600">
						{error}
					</p>
				)}
				<div className="flex justify-end gap-2">
					<Button type="button" variant="outline" onClick={() => close(false)} disabled={busy}>
						Cancel
					</Button>
					<Button type="button" onClick={() => void choose()} disabled={busy || chooseDisabled}>
						{busy ? "Working…" : `${verb} to ${current ? current.name : "My Drive"}`}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
