"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { InstructionSet } from "@/lib/agent/instruction-types";
import { InstructionFields } from "./instruction-fields";
import { WritingStyleSetting } from "./writing-style-setting";
import { overLimit } from "./instruction-fields-utils";
import {
	loadPersonalInstructions,
	savePersonalInstructions,
	type PersonalInstructionsState,
} from "./personal-instructions-utils";

const same = (a: InstructionSet, b: InstructionSet) =>
	a.general === b.general && a.chat === b.chat && a.draft === b.draft && a.summary === b.summary;

/** "My instructions": the signed-in user's own preferences, used in every mailbox and visible to nobody else. */
export function PersonalInstructionsSetting() {
	const [saved, setSaved] = useState<PersonalInstructionsState | null>(null);
	const [values, setValues] = useState<InstructionSet | null>(null);
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);

	useEffect(() => {
		let active = true;
		loadPersonalInstructions()
			.then((state) => {
				if (!active) return;
				setSaved(state);
				setValues(state.instructions);
			})
			.catch((error: unknown) => {
				if (active) setMessage({ tone: "error", text: error instanceof Error ? error.message : "Failed to load" });
			});
		return () => {
			active = false;
		};
	}, []);

	const max = saved?.maxLength ?? 2_000;
	const limits = { general: max, chat: max, draft: max, summary: max };
	const invalid = !values || overLimit(values, limits);
	const unchanged = !values || !saved || same(values, saved.instructions);

	async function save() {
		if (!values || invalid) return;
		setSaving(true);
		setMessage(null);
		try {
			const state = await savePersonalInstructions(values);
			setSaved(state);
			setValues(state.instructions);
			setMessage({ tone: "ok", text: "Saved" });
		} catch (error) {
			setMessage({ tone: "error", text: error instanceof Error ? error.message : "Failed to save your instructions" });
		} finally {
			setSaving(false);
		}
	}

	return (
		<>
			<section
				aria-labelledby="personal-instructions-heading"
				className="space-y-2 rounded-2xl border border-neutral-200 p-3"
			>
				<p id="personal-instructions-heading" className="font-medium text-neutral-800">
					My instructions
				</p>
				<p className="text-xs text-neutral-500">
					Your own preferences, used in every mailbox you work in and never shown to anyone else. A mailbox&apos;s
					instructions come first and win.
				</p>
				{saved && !saved.ready && (
					<p className="text-xs text-amber-700">Apply the pending database update to use your own instructions.</p>
				)}
				{values && (
					<InstructionFields
						idPrefix="personal-instructions"
						values={values}
						limits={limits}
						disabled={!saved?.ready || saving}
						onChange={(key, value) => {
							setValues({ ...values, [key]: value });
							setMessage(null);
						}}
					/>
				)}
				<div className="flex items-center gap-3">
					<Button
						type="button"
						size="sm"
						disabled={invalid || unchanged || saving || !saved?.ready}
						onClick={() => void save()}
					>
						Save my instructions
					</Button>
					{message && (
						<span role="status" className={`text-xs ${message.tone === "error" ? "text-red-600" : "text-neutral-500"}`}>
							{message.text}
						</span>
					)}
				</div>
			</section>
			<WritingStyleSetting />
		</>
	);
}
