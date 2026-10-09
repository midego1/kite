"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { BrandingContextValue } from "./branding-provider-types";
import { DEFAULT_BRANDING, fetchBranding } from "./branding-provider-utils";

const BrandingContext = createContext<BrandingContextValue | null>(null);

export function BrandingProvider({ children }: { children: React.ReactNode }) {
	const [branding, setBranding] = useState(DEFAULT_BRANDING);
	const [iconVersion, setIconVersion] = useState(0);

	function applyBranding(nextBranding: Awaited<ReturnType<typeof fetchBranding>>) {
		setBranding(nextBranding);
		setIconVersion(Date.now());
		if (document.title === DEFAULT_BRANDING.appName || document.title === branding.appName) {
			document.title = nextBranding.appName;
		}
	}

	async function refreshBranding() {
		applyBranding(await fetchBranding());
	}

	useEffect(() => {
		let cancelled = false;
		void fetchBranding().then((nextBranding) => {
			if (!cancelled) applyBranding(nextBranding);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<BrandingContext.Provider
			value={{
				...branding,
				iconUrl: branding.hasCustomIcon ? `/api/branding/icon?v=${iconVersion}` : "/icon-96.png",
				refreshBranding,
			}}
		>
			{children}
		</BrandingContext.Provider>
	);
}

export function useBranding() {
	return (
		useContext(BrandingContext) ?? {
			...DEFAULT_BRANDING,
			iconUrl: "/icon-96.png",
			refreshBranding: async () => undefined,
		}
	);
}
