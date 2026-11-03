"use client";

import { Moon, Sun } from "lucide-react";
import { saveThemePreference } from "@/components/theme-utils";

/**
 * The chrome's sun and moon. It uses the app's own theme setting (theme-utils.ts): it saves the choice under the
 * same key, flips the html class the same way and tells the rest of the app through the same event. The icon and the
 * name follow the html class in CSS, so the server markup is right for either theme and nothing flashes.
 */
export function HomeThemeToggle() {
	const toggle = () => {
		const dark = document.documentElement.classList.contains("dark");
		saveThemePreference(dark ? "light" : "dark");
	};

	return (
		<button
			type="button"
			onClick={toggle}
			className="flex h-9 w-9 items-center justify-center rounded-lg text-neutral-600 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
		>
			<Sun className="hidden h-[18px] w-[18px] dark:block" aria-hidden="true" />
			<Moon className="block h-[18px] w-[18px] dark:hidden" aria-hidden="true" />
			<span className="sr-only dark:hidden">Switch to dark mode</span>
			<span className="sr-only hidden dark:inline">Switch to light mode</span>
		</button>
	);
}
