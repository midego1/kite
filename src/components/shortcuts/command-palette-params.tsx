"use client";

import React, { useEffect, useRef } from "react";
import type { CommandItem } from "./types";

/** Asks for the values a command needs before it runs; Enter in any field submits. */
export function CommandParamForm({
	item,
	values,
	error,
	onChange,
}: {
	item: CommandItem;
	values: Record<string, string>;
	error: string | null;
	onChange: (name: string, value: string) => void;
}) {
	const first = useRef<HTMLInputElement>(null);
	useEffect(() => {
		first.current?.focus();
	}, []);

	return (
		<div className="p-4 space-y-3">
			<div className="text-sm font-medium text-neutral-800">{item.title}</div>
			{(item.params ?? []).map((field, index) => (
				<label key={field.name} className="block text-xs font-medium text-neutral-500">
					{field.name}
					{field.required ? "" : " (optional)"}
					<input
						ref={index === 0 ? first : undefined}
						type="text"
						value={values[field.name] ?? ""}
						onChange={(event) => onChange(field.name, event.target.value)}
						placeholder={field.hint}
						className="mt-1 w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 placeholder-neutral-400 focus:border-blue-500 focus:outline-none"
					/>
				</label>
			))}
			{error && (
				<p role="alert" className="text-xs text-red-600">
					{error}
				</p>
			)}
		</div>
	);
}
