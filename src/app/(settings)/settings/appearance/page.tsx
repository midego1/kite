import { AppearanceSettings } from "@/components/settings/appearance-settings";

export default function SettingsAppearancePage() {
	return (
		<div className="space-y-8 py-4">
			<section className="space-y-4">
				<div>
					<h1 className="text-2xl font-bold text-neutral-900 md:text-3xl">Appearance</h1>
					<p className="mt-1 text-sm text-neutral-500">Make Kite feel at home: theme, style, font and text size.</p>
				</div>
				<div className="rounded-3xl bg-white p-6">
					<AppearanceSettings />
				</div>
			</section>
		</div>
	);
}
