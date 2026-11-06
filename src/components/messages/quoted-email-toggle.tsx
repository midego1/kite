import { EmailHtmlFrame } from "./email-html-frame";
import type { QuotedEmailToggleProps } from "./quoted-email-toggle-types";
import { useT } from "@/lib/i18n/use-t";

export function QuotedEmailToggle({ html, colours, original }: QuotedEmailToggleProps) {
	const t = useT();
	return (
		<details className="email-quote-toggle">
			<summary aria-label={t("Toggle quoted email")} title={t("Show or hide quoted email")} />
			<EmailHtmlFrame
				html={html}
				colours={colours}
				title={t("Quoted message")}
				muted
				original={original}
				className="email-quote-content"
			/>
		</details>
	);
}
