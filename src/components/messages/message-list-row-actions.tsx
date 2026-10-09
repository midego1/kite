"use client";

import { useState } from "react";
import { Archive, Clock, Mail, MailOpen, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import type { MessageListRowActionsProps } from "./types";
import { getSnoozePresets, isMessageSnoozed, snoozeMessage, unsnoozeMessage } from "./message-list-row-actions-utils";
import { getUserTimeZone } from "@/lib/time/utils";

export function MessageListRowActions({ message, onAction, compact = false }: MessageListRowActionsProps) {
	const [snoozeOpen, setSnoozeOpen] = useState(false);
	const [snoozedUntil, setSnoozedUntil] = useState(() => getSnoozePresets()[0].value);
	const [snoozing, setSnoozing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const snoozePresets = getSnoozePresets();
	const snoozed = isMessageSnoozed(message.snoozedUntil);
	const readAction = message.read ? "unread" : "read";
	const buttonClassName = compact ? "h-6 w-6 p-0" : undefined;

	async function handleSnooze() {
		setSnoozing(true);
		setError(null);
		try {
			await snoozeMessage(message.id, snoozedUntil);
			setSnoozeOpen(false);
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : "Unable to snooze message");
		} finally {
			setSnoozing(false);
		}
	}

	return (
		<>
			<div
				className={`pointer-events-none absolute z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:opacity-100 ${compact ? "right-0 top-0 h-6 gap-0.5" : "right-6 top-1/2 -translate-y-1/2 bg-[#f2f6fc] pl-3"}`}
			>
				<Tooltip label="Archive">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className={buttonClassName}
						onClick={() => void onAction("archive")}
						aria-label="Archive"
					>
						<Archive className="h-4 w-4" />
					</Button>
				</Tooltip>
				<Tooltip label="Trash">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className={buttonClassName}
						onClick={() => void onAction("trash")}
						aria-label="Trash"
					>
						<Trash2 className="h-4 w-4" />
					</Button>
				</Tooltip>
				<Tooltip label={readAction === "read" ? "Mark as read" : "Mark as unread"}>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className={buttonClassName}
						onClick={() => void onAction(readAction)}
						aria-label={readAction === "read" ? "Mark as read" : "Mark as unread"}
					>
						{readAction === "read" ? <MailOpen className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
					</Button>
				</Tooltip>
				<Tooltip label={snoozed ? "Unsnooze" : "Snooze"}>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className={buttonClassName}
						onClick={() => {
							if (snoozed) {
								void unsnoozeMessage(message.id);
								return;
							}
							setSnoozeOpen(true);
						}}
						aria-label={snoozed ? "Unsnooze" : "Snooze"}
					>
						<Clock className="h-4 w-4" />
					</Button>
				</Tooltip>
			</div>

			<Dialog open={snoozeOpen} onOpenChange={setSnoozeOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Snooze email</DialogTitle>
						<DialogDescription>Hide this email from the inbox until the time you choose.</DialogDescription>
					</DialogHeader>
					<div className="space-y-4">
						<div className="grid gap-2 sm:grid-cols-3">
							{snoozePresets.map((preset) => (
								<Button
									key={preset.label}
									type="button"
									variant="outline"
									size="sm"
									className={buttonClassName}
									onClick={() => setSnoozedUntil(preset.value)}
								>
									{preset.label}
								</Button>
							))}
						</div>
						<div className="space-y-2">
							<label htmlFor={`snooze-until-${message.id}`} className="text-sm font-medium text-neutral-700">
								Select date and time ({getUserTimeZone()})
							</label>
							<Input
								id={`snooze-until-${message.id}`}
								type="datetime-local"
								value={snoozedUntil}
								onChange={(event) => setSnoozedUntil(event.target.value)}
							/>
						</div>
						{error && <p className="text-sm text-red-600">{error}</p>}
						<Button type="button" onClick={() => void handleSnooze()} disabled={snoozing}>
							{snoozing ? "Snoozing..." : "Snooze"}
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}
