import { InboxRules } from "@/components/settings/inbox-rules";
import { DomainRouting } from "@/components/settings/domain-routing/domain-routing";
import { PageHeader } from "@/components/ui/page";

export default function SettingsRulesPage() {
	return (
		<div className="space-y-8">
			<PageHeader
				title="Rules & routing"
				description="Rules for the selected inbox, and how mail to your domains is delivered."
			/>
			<div>
				<DomainRouting />
			</div>
			<div className="py-6">
				<InboxRules />
			</div>
		</div>
	);
}
