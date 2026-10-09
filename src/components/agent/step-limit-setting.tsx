"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { AssistantOutputSettings } from "@/components/settings/appearance-settings";
import { AGENT_MAX_STEPS_MAX, AGENT_MAX_STEPS_MIN, isAgentMaxSteps } from "@/lib/agent/step-limit-utils";
import { loadAgentMaxSteps, saveAgentMaxSteps } from "./step-limit-setting-utils";

export function AgentStepLimitSetting() {
	const [saved, setSaved] = useState<number | null>(null);
	const [value, setValue] = useState("");
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);

	useEffect(() => {
		let active = true;
		loadAgentMaxSteps()
			.then((steps) => {
				if (active) {
					setSaved(steps);
					setValue(String(steps));
				}
			})
			.catch((error: unknown) => {
				if (active)
					setMessage({
						tone: "error",
						text: error instanceof Error ? error.message : "Failed to load assistant settings",
					});
			});
		return () => {
			active = false;
		};
	}, []);

	const parsed = Number(value);
	const valid = value.trim() !== "" && isAgentMaxSteps(parsed);

	async function save() {
		if (!valid) return;
		setSaving(true);
		setMessage(null);
		try {
			const steps = await saveAgentMaxSteps(parsed);
			setSaved(steps);
			setValue(String(steps));
			setMessage({ tone: "ok", text: "Saved" });
		} catch (error) {
			setMessage({ tone: "error", text: error instanceof Error ? error.message : "Failed to save assistant settings" });
		} finally {
			setSaving(false);
		}
	}

	return (
		<>
			<div className="space-y-2">
				<p className="font-medium text-neutral-800">Display</p>
				<AssistantOutputSettings compact />
			</div>
			<div className="space-y-2 rounded-2xl border border-neutral-200 p-3">
				<p className="font-medium text-neutral-800">Step limit</p>
				<label className="block">
					Max steps per question
					<input
						className="mt-2 w-full rounded-xl border border-neutral-200 p-2 outline-none focus:border-blue-400"
						type="number"
						name="agentMaxSteps"
						min={AGENT_MAX_STEPS_MIN}
						max={AGENT_MAX_STEPS_MAX}
						step={1}
						value={value}
						disabled={saved === null || saving}
						aria-invalid={!valid}
						onChange={(event) => {
							setValue(event.target.value);
							setMessage(null);
						}}
					/>
				</label>
				<p className="text-xs text-neutral-500">Each tool call counts as a step.</p>
				<details className="text-xs text-neutral-500">
					<summary className="cursor-pointer">Limit help</summary>
					Higher limits take longer and use more AI quota. Allowed: {AGENT_MAX_STEPS_MIN} to {AGENT_MAX_STEPS_MAX}.
				</details>
				<div className="flex items-center gap-3">
					<Button type="button" size="sm" disabled={!valid || saving || parsed === saved} onClick={() => void save()}>
						Save step limit
					</Button>
					{message && (
						<span role="status" className={`text-xs ${message.tone === "error" ? "text-red-600" : "text-neutral-500"}`}>
							{message.text}
						</span>
					)}
				</div>
			</div>
		</>
	);
}
