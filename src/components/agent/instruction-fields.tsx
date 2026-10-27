"use client";

import type { InstructionSet } from "@/lib/agent/instruction-types";
import { characterCount, INSTRUCTION_FIELDS, type InstructionFieldKey } from "./instruction-fields-utils";

type InstructionFieldsProps = {
	/** Prefixes element ids, so the mailbox and personal sections can share a page. */
	idPrefix: string;
	values: InstructionSet;
	limits: Record<InstructionFieldKey, number>;
	/** Disables every field; `lockedTasks` disables only the task fields (before their migration). */
	disabled?: boolean;
	lockedTasks?: boolean;
	onChange: (key: InstructionFieldKey, value: string) => void;
};

/** The instruction fields as an accordion: General starts open, each field with a character counter. */
export function InstructionFields({
	idPrefix,
	values,
	limits,
	disabled,
	lockedTasks,
	onChange,
}: InstructionFieldsProps) {
	return (
		<div className="divide-y divide-neutral-200 rounded-xl border border-neutral-200">
			{INSTRUCTION_FIELDS.map((field) => {
				const id = `${idPrefix}-${field.key}`;
				const max = limits[field.key];
				const over = Array.from(values[field.key]).length > max;
				const locked = disabled || (lockedTasks && field.key !== "general");
				return (
					<details key={field.key} open={field.key === "general"} className="group px-3 py-2">
						<summary className="cursor-pointer text-sm font-medium text-neutral-800">
							{field.label}
							{values[field.key].trim() && <span className="ml-2 text-xs font-normal text-blue-700">Set</span>}
						</summary>
						<label htmlFor={id} className="sr-only">
							{field.label}
						</label>
						<textarea
							id={id}
							name={id}
							className="mt-2 min-h-24 w-full rounded-xl border border-neutral-200 bg-white p-2 text-sm outline-none focus:border-blue-400 disabled:opacity-60"
							value={values[field.key]}
							disabled={locked}
							aria-invalid={over}
							aria-describedby={`${id}-count`}
							onChange={(event) => onChange(field.key, event.target.value)}
						/>
						<div className="flex justify-between gap-3 text-xs text-neutral-500">
							<span>{field.hint}</span>
							<span id={`${id}-count`} className={over ? "text-red-600" : undefined}>
								{characterCount(values[field.key], max)}
							</span>
						</div>
					</details>
				);
			})}
		</div>
	);
}
