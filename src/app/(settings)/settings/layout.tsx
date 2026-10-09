import type { ReactNode } from "react";
import { SectionLayout } from "@/components/settings/section-layout";

export default function SettingsLayout({ children }: { children: ReactNode }) {
	return <SectionLayout mode="settings">{children}</SectionLayout>;
}
