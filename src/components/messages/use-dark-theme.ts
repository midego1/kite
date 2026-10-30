import { useSyncExternalStore } from "react";

function subscribeToTheme(onChange: () => void) {
	const observer = new MutationObserver(onChange);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
	return () => observer.disconnect();
}

export function useDarkTheme(): boolean {
	return useSyncExternalStore(
		subscribeToTheme,
		() => document.documentElement.classList.contains("dark"),
		() => false,
	);
}
