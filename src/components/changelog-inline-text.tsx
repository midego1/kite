import Link from "next/link";
import { isAppChangelogHref, parseInlineMarkdown } from "@/lib/changelog/changelog-utils";
import type { ChangelogInline } from "@/lib/changelog/types";

const LINK_CLASS = "text-blue-700 underline underline-offset-2 hover:text-blue-800";

function InlineToken({ token, onNavigate }: { token: ChangelogInline; onNavigate: () => void }) {
	if (token.type === "code") {
		return (
			<code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[12px] text-neutral-800">{token.text}</code>
		);
	}
	if (token.type === "strong") return <strong className="font-semibold text-neutral-900">{token.text}</strong>;
	if (token.type === "link") {
		// A link into the app (for example the setting a note talks about) opens
		// in this tab and closes the dialog; outside links open in a new tab.
		if (isAppChangelogHref(token.href)) {
			return (
				<Link href={token.href} className={LINK_CLASS} onClick={onNavigate}>
					{token.text}
				</Link>
			);
		}
		return (
			<a href={token.href} target="_blank" rel="noreferrer" className={LINK_CLASS}>
				{token.text}
			</a>
		);
	}
	return token.text;
}

/** Every changelog item is written as text nodes, so nothing in the file can become markup. */
export function InlineText({ text, onNavigate }: { text: string; onNavigate: () => void }) {
	return parseInlineMarkdown(text).map((token, index) => (
		<InlineToken key={index} token={token} onNavigate={onNavigate} />
	));
}
