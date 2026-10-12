import { textToHtml } from "@/components/compose/rich-text-utils";
import { stripDraftMarkdown } from "./auto-read/draft-guard-utils";

export function formatAgentDraftBody(body: string) {
	const text = stripDraftMarkdown(body);
	return { text, html: textToHtml(text) };
}
