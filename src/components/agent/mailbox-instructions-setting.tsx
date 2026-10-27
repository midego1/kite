"use client";

import {
	GENERAL_INSTRUCTIONS_MAX_CHARS as GENERAL_MAX,
	TASK_INSTRUCTIONS_MAX_CHARS as TASK_MAX,
} from "@/lib/agent/instruction-utils";
import { FixedRulesNote } from "./fixed-rules-note";
import { InstructionFields } from "./instruction-fields";
import type { InstructionFieldKey } from "./instruction-fields-utils";
import type { AgentSettings, InstructionContext } from "./types";

const SETTINGS_KEYS = {
	general: "instructions",
	chat: "chatInstructions",
	draft: "draftInstructions",
	summary: "summaryInstructions",
} as const satisfies Record<InstructionFieldKey, keyof AgentSettings>;

const MAILBOX_INSTRUCTION_LIMITS = { general: GENERAL_MAX, chat: TASK_MAX, draft: TASK_MAX, summary: TASK_MAX };

/** "Instructions for this mailbox", saved with the mailbox settings by their Save button. */
export function MailboxInstructionsSetting({
	settings,
	canManage,
	context,
	onChange,
}: {
	settings: AgentSettings;
	canManage: boolean;
	/** Before migration 0069 (`ready` false) only the general field can be edited. */
	context: InstructionContext | null;
	onChange: (settings: AgentSettings) => void;
}) {
	const ready = context?.ready !== false;
	// A response from a server without these fields (or a stale one) must not break the settings view.
	const values = {
		general: settings.instructions ?? "",
		chat: settings.chatInstructions ?? "",
		draft: settings.draftInstructions ?? "",
		summary: settings.summaryInstructions ?? "",
	};
	return (
		<div className="space-y-2">
			<p className="font-medium text-neutral-800">Instructions for this mailbox</p>
			<p className="text-xs text-neutral-500">
				They add preferences for everyone who uses the assistant here and never replace Kite&apos;s own rules.
			</p>
			{!ready && (
				<p className="text-xs text-amber-700">
					Apply the pending database update to use the Chat, Drafting and Summaries fields.
				</p>
			)}
			<InstructionFields
				idPrefix="mailbox-instructions"
				values={values}
				limits={MAILBOX_INSTRUCTION_LIMITS}
				disabled={!canManage}
				lockedTasks={!ready}
				onChange={(key, value) => onChange({ ...settings, [SETTINGS_KEYS[key]]: value })}
			/>
			{context && <FixedRulesNote rules={context.fixedRules} />}
		</div>
	);
}
