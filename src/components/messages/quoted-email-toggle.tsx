import { EmailHtmlFrame } from "./email-html-frame";
import type { QuotedEmailToggleProps } from "./quoted-email-toggle-types";

export function QuotedEmailToggle({ html }: QuotedEmailToggleProps) {
	return (
		<details className="email-quote-toggle">
			<summary aria-label="Toggle quoted email" title="Show or hide quoted email" />
			<EmailHtmlFrame html={html} title="Quoted message" muted className="email-quote-content" />
		</details>
	);
}
