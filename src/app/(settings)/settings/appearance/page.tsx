import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { PageHeader } from "@/components/ui/page";

export default function SettingsAppearancePage() {
	return (
		<div className="space-y-6">
			<PageHeader
				title="Appearance"
				description="Theme, style, font and text size, and how the assistant shows its work. These choices are saved in this browser."
			/>
			<AppearanceSettings />
		</div>
	);
}
