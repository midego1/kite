"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PendingConfirmation } from "./confirm-dialog-types";
import {
	matchesTypedConfirmation,
	requestConfirmation,
	settleConfirmation,
	subscribeToConfirmations,
} from "./confirm-dialog-utils";

/** Promise-based replacement for window.confirm, backed by the shared ConfirmDialogHost. */
export function useConfirm() {
	return requestConfirmation;
}

function ConfirmDialogBody({ pending }: { pending: PendingConfirmation }) {
	const [typed, setTyped] = useState("");
	const inputId = useId();
	const destructive = pending.destructive ?? true;
	const canConfirm = matchesTypedConfirmation(pending.typedConfirmation, typed);

	return (
		<DialogPrimitive.Root
			open
			onOpenChange={(open) => {
				if (!open) settleConfirmation(pending.id, false);
			}}
		>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay className="dialog-overlay fixed inset-0 z-[60] bg-black/35" />
				<DialogPrimitive.Content
					role="alertdialog"
					className="dialog-content fixed left-1/2 top-1/2 z-[60] max-h-[calc(100vh-4rem)] w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"
					onOpenAutoFocus={(event) => {
						if (pending.typedConfirmation) return;
						// Land on Cancel, so pressing Enter by reflex does not confirm a destructive action.
						event.preventDefault();
						(event.currentTarget as HTMLElement).querySelector<HTMLButtonElement>("[data-confirm-cancel]")?.focus();
					}}
				>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							if (canConfirm) settleConfirmation(pending.id, true);
						}}
					>
						<DialogPrimitive.Title className="text-lg font-semibold text-neutral-900">
							{pending.title}
						</DialogPrimitive.Title>
						{pending.description ? (
							<DialogPrimitive.Description className="mt-2 whitespace-pre-line text-sm text-neutral-600">
								{pending.description}
							</DialogPrimitive.Description>
						) : (
							<DialogPrimitive.Description className="sr-only">
								Confirm or cancel this action.
							</DialogPrimitive.Description>
						)}
						{pending.typedConfirmation && (
							<div className="mt-4 space-y-1.5">
								<label htmlFor={inputId} className="text-sm text-neutral-700">
									Type <span className="font-mono font-semibold">{pending.typedConfirmation}</span> to confirm.
								</label>
								<Input
									id={inputId}
									value={typed}
									autoComplete="off"
									autoFocus
									onChange={(event) => setTyped(event.target.value)}
								/>
							</div>
						)}
						<div className="mt-6 flex justify-end gap-2">
							<Button
								type="button"
								variant="outline"
								data-confirm-cancel
								onClick={() => settleConfirmation(pending.id, false)}
							>
								{pending.cancelLabel ?? "Cancel"}
							</Button>
							<Button type="submit" variant={destructive ? "destructive" : "default"} disabled={!canConfirm}>
								{pending.confirmLabel ?? "Confirm"}
							</Button>
						</div>
					</form>
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}

/** Renders confirmations requested with useConfirm or requestConfirmation; mount once near the root. */
export function ConfirmDialogHost() {
	const [pending, setPending] = useState<PendingConfirmation | null>(null);
	useEffect(() => subscribeToConfirmations(setPending), []);
	return pending ? <ConfirmDialogBody key={pending.id} pending={pending} /> : null;
}
