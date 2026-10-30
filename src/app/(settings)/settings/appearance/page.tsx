import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { PageHeader } from "@/components/ui/page";

export default function SettingsAppearancePage() {
	return (
		<div className="space-y-6">
			<PageHeader
				title="Appearance"
				description="Theme, style, font and text size, and how the assistant shows its work. Most of these choices are kept per browser."
			/>
			<AppearanceSettings />
		</div>
	);
}
