"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingRow, SettingRows } from "@/components/ui/page";
import { Switch } from "@/components/ui/switch";
import type { AutoReadAdminValues, AutoReadStatus } from "./auto-read-settings-types";
import {
	capInputAfterSave,
	loadAutoReadAdmin,
	microsToDollarInput,
	parseDollarInput,
	saveAutoReadAdmin,
	spentTodayText,
} from "./auto-read-settings-utils";
import { TokenAllowanceForm } from "./token-allowance-form";

export function AutoReadAdminSettings() {
	const [values, setValues] = useState<AutoReadAdminValues | null>(null);
	const [cap, setCap] = useState("");
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<AutoReadStatus>(null);

	useEffect(() => {
		let active = true;
		loadAutoReadAdmin()
			.then((data) => {
				if (!active) return;
				setValues(data);
				setCap(microsToDollarInput(data.dailySpendCapMicros));
			})
			.catch((error: unknown) => {
				if (active)
					setStatus({
						tone: "error",
						text: error instanceof Error ? error.message : "Could not load automatic reading settings",
					});
			});
		return () => {
			active = false;
		};
	}, []);

	async function save(update: Partial<AutoReadAdminValues>) {
		setBusy(true);
		setStatus(null);
		try {
			const saved = await saveAutoReadAdmin(update);
			setValues(saved);
			setCap((input) => capInputAfterSave(input, values, update, saved));
			setStatus({ tone: "ok", text: "Automatic reading settings saved." });
		} catch (error) {
			setStatus({ tone: "error", text: error instanceof Error ? error.message : "Could not save" });
		} finally {
			setBusy(false);
		}
	}

	function saveCap(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const micros = parseDollarInput(cap);
		if (micros === null || micros === undefined)
			return setStatus({ tone: "error", text: "Enter a daily spend cap of $0 or more." });
		void save({ dailySpendCapMicros: micros });
	}

	const locked = !values || busy;
	return (
		<Card>
			<CardHeader>
				<CardTitle>Automatic reading</CardTitle>
				<CardDescription>
					Mailboxes that turn on automatic reading have new mail read by the assistant, which suggests summaries,
					replies and warnings. Nothing is sent or changed without a person accepting it.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-5 pt-4">
				<SettingRows>
					<SettingRow
						label="Enable automatic reading"
						description="Turning this off stops all automatic reading at once and skips queued work."
						control={
							<Switch
								checked={values?.autoReadEnabled ?? false}
								disabled={locked}
								onCheckedChange={(autoReadEnabled) => void save({ autoReadEnabled })}
								aria-label="Enable automatic reading"
							/>
						}
					/>
					<SettingRow
						label="Allow an external AI provider for automatic reading and the composer"
						description="Lets automatic reading, Write with Kite in the composer and summaries send message content to the configured external AI provider. Workers AI is always allowed."
						control={
							<Switch
								checked={values?.externalAutoReadAllowed ?? false}
								disabled={locked}
								onCheckedChange={(externalAutoReadAllowed) => void save({ externalAutoReadAllowed })}
								aria-label="Allow an external AI provider for automatic reading and the composer"
							/>
						}
					/>
				</SettingRows>
				<form onSubmit={saveCap} className="space-y-2">
					<Label htmlFor="auto-read-install-cap">Daily spend cap for automatic reading and chat (USD)</Label>
					<div className="flex flex-wrap items-center gap-3">
						<Input
							id="auto-read-install-cap"
							type="number"
							min="0"
							step="0.01"
							className="w-40"
							value={cap}
							disabled={locked}
							onChange={(event) => setCap(event.target.value)}
						/>
						<Button type="submit" disabled={locked}>
							Save spend cap
						</Button>
					</div>
					<p className="text-xs text-neutral-500">
						Shared by automatic reading and assistant chat in every mailbox, counted from midnight UTC. Both stop for
						the day when it is reached. It counts every model with a cost rate, including rates from Kite&apos;s price
						list.
					</p>
					{values?.spentTodayMicros !== undefined && (
						<p className="text-xs text-neutral-700" data-testid="spent-today">
							{spentTodayText(values.spentTodayMicros, values.dailySpendCapMicros)}
						</p>
					)}
				</form>
				<TokenAllowanceForm
					key={values ? `${values.autoReadTokenCap}:${values.chatTokenCap}` : "loading"}
					values={values}
					locked={locked}
					onSave={(update) => void save(update)}
					onInvalid={(text) => setStatus({ tone: "error", text })}
				/>
				{status && (
					<p role="status" className={`text-sm ${status.tone === "error" ? "text-red-700" : "text-neutral-700"}`}>
						{status.text}
					</p>
				)}
			</CardContent>
		</Card>
	);
}
