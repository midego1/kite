import { EmailHtmlFrame } from "./email-html-frame";
import type { QuotedEmailToggleProps } from "./quoted-email-toggle-types";

export function QuotedEmailToggle({ html, original }: QuotedEmailToggleProps) {
	return (
		<details className="email-quote-toggle">
			<summary aria-label="Toggle quoted email" title="Show or hide quoted email" />
			<EmailHtmlFrame html={html} title="Quoted message" muted original={original} className="email-quote-content" />
		</details>
	);
}
