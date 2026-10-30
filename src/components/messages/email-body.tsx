"use client";

import { useState } from "react";
import { Sun } from "lucide-react";
import { EmailHtmlFrame } from "./email-html-frame";
import { adaptsEmailColours } from "./email-html-frame-utils";
import { QuotedEmailToggle } from "./quoted-email-toggle";
import { useDarkTheme } from "./use-dark-theme";
import type { EmailBodyProps } from "./email-body-types";

/**
 * A message's body and its quoted history. In dark mode, when either one's colours were adapted, one small
 * "Original colours" button above the body shows the sender's colours in both.
 */
export function EmailBody({ html, quotedHtml, fallback, className }: EmailBodyProps) {
	const dark = useDarkTheme();
	const [original, setOriginal] = useState(false);
	const adapted = dark && ((!!html && adaptsEmailColours(html)) || (!!quotedHtml && adaptsEmailColours(quotedHtml)));
	return (
		<>
			{adapted && (
				<div className="mb-2 flex justify-end">
					<button
						type="button"
						onClick={() => setOriginal((current) => !current)}
						// One fixed label with a pressed state: "Original colours, pressed" reads as on or off.
						aria-pressed={original}
						className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
					>
						<Sun className="h-3.5 w-3.5" aria-hidden="true" />
						Original colours
					</button>
				</div>
			)}
			{html ? <EmailHtmlFrame html={html} original={original} className={className} /> : fallback}
			{quotedHtml && <QuotedEmailToggle html={quotedHtml} original={original} />}
		</>
	);
}
