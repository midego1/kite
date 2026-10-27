"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AutoReadAdminValues } from "./auto-read-settings-types";
import { parseTokenAllowance } from "./auto-read-settings-utils";

type TokenAllowanceFormProps = {
	values: AutoReadAdminValues | null;
	locked: boolean;
	onSave: (update: Pick<AutoReadAdminValues, "autoReadTokenCap" | "chatTokenCap">) => void;
	onInvalid: (message: string) => void;
};

/**
 * The daily input-token allowances used when a model has no prices: one for automatic reading and one for chat,
 * so neither can use up the other's. Disabled until migration 0069 is applied. The parent remounts it with a
 * `key` of the saved values, so the inputs start from what was saved.
 */
export function TokenAllowanceForm({ values, locked, onSave, onInvalid }: TokenAllowanceFormProps) {
	const [autoRead, setAutoRead] = useState(values ? String(values.autoReadTokenCap) : "");
	const [chat, setChat] = useState(values ? String(values.chatTokenCap) : "");
	const pending = values?.tokenCapsReady === false;

	function submit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const autoReadTokenCap = parseTokenAllowance(autoRead);
		const chatTokenCap = parseTokenAllowance(chat);
		if (autoReadTokenCap === null || chatTokenCap === null)
			return onInvalid("Enter whole numbers of tokens from 1,000 to 1,000,000,000.");
		onSave({ autoReadTokenCap, chatTokenCap });
	}

	return (
		<form onSubmit={submit} className="space-y-3" aria-labelledby="token-allowance-heading">
			<div>
				<p id="token-allowance-heading" className="font-medium text-neutral-900">
					Daily token allowances without model prices
				</p>
				<p className="mt-1 text-sm text-neutral-500">
					When a model has no prices in the provider settings, Kite cannot count dollars and counts input tokens
					instead. Automatic reading and chat each have their own allowance, counted from midnight UTC. Setting prices
					gives you the dollar cap above instead.
				</p>
				{pending && (
					<p className="mt-1 text-sm text-amber-700">Apply the pending database update to change these allowances.</p>
				)}
			</div>
			<div className="flex flex-wrap items-end gap-3">
				<div className="space-y-1">
					<Label htmlFor="auto-read-token-cap">Automatic reading (input tokens a day)</Label>
					<Input
						id="auto-read-token-cap"
						type="number"
						min="1000"
						step="1000"
						className="w-48"
						value={autoRead}
						disabled={locked || pending}
						onChange={(event) => setAutoRead(event.target.value)}
					/>
				</div>
				<div className="space-y-1">
					<Label htmlFor="chat-token-cap">Chat and Write with Kite (input tokens a day)</Label>
					<Input
						id="chat-token-cap"
						type="number"
						min="1000"
						step="1000"
						className="w-48"
						value={chat}
						disabled={locked || pending}
						onChange={(event) => setChat(event.target.value)}
					/>
				</div>
				<Button type="submit" disabled={locked || pending}>
					Save token allowances
				</Button>
			</div>
		</form>
	);
}
