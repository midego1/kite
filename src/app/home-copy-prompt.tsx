"use client";

import { useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { MONO } from "./home-ui";

/**
 * The deploy prompt in a block with a button that copies it. The text comes from the server page (it is the README's
 * prompt, verbatim, in home-content.ts). Tokens are never in it: the agent has to ask for them.
 */
export function HomeCopyPrompt({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	const preRef = useRef<HTMLPreElement>(null);

	// Without the clipboard API (plain http, as a Docker install is served) or its permission, select the prompt
	// shown in the pre instead; where execCommand still works that selection is copied, else it stays selected.
	const selectPrompt = () => {
		const pre = preRef.current;
		if (!pre) return;
		const range = document.createRange();
		range.selectNodeContents(pre);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		setCopied(document.execCommand("copy"));
	};

	const copyPrompt = () => {
		if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
			void navigator.clipboard.writeText(text).then(() => setCopied(true), selectPrompt);
			return;
		}
		selectPrompt();
	};

	return (
		<div>
			<div className="mb-2 flex justify-end">
				<button
					type="button"
					onClick={copyPrompt}
					className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 text-xs font-medium text-neutral-800 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
				>
					{copied ? (
						<Check className="h-3.5 w-3.5" aria-hidden="true" />
					) : (
						<Copy className="h-3.5 w-3.5" aria-hidden="true" />
					)}
					{copied ? "Copied" : "Copy prompt"}
				</button>
			</div>
			<pre
				ref={preRef}
				className={`${MONO} max-w-full overflow-x-auto whitespace-pre-wrap rounded-lg border border-neutral-200 bg-neutral-100 p-4 text-left leading-5 text-neutral-700`}
			>
				{text}
			</pre>
		</div>
	);
}
