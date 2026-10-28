"use client";

import { useState } from "react";
import { useBranding } from "@/components/branding-provider";
import { useKeyChanged, useSyncedState } from "@/hooks/use-synced-state";
import type { AuthShellProps } from "./types";

export function AuthShell({ icon: Icon, title, description, children, footer, steps }: AuthShellProps) {
	const branding = useBranding();
	const [iconUrl, setIconUrl] = useSyncedState(branding.iconUrl);
	const [iconFailed, setIconFailed] = useState(false);
	if (useKeyChanged(branding.iconUrl)) setIconFailed(false);

	return (
		// The Zero look's sign-in: one bordered card on the page background, the product above it. Forms with steps
		// (first-run setup, onboarding) get a wider card.
		<div className="flex min-h-dvh flex-col items-center bg-[#f6f8fc] px-4 py-10 text-neutral-900 sm:justify-center sm:py-12">
			<main className={`w-full ${steps ? "max-w-xl" : "max-w-md"}`}>
				<div className="mb-6 flex items-center justify-center gap-2">
					<span className="flex items-center justify-center overflow-hidden">
						{iconFailed ? (
							<Icon className="h-7 w-7 text-blue-600" />
						) : (
							<img
								src={iconUrl}
								onError={() => {
									if (iconUrl !== "/icon-96.png") setIconUrl("/icon-96.png");
									else setIconFailed(true);
								}}
								alt=""
								className="h-7 w-7 object-contain"
							/>
						)}
					</span>
					<span className="truncate text-base font-semibold text-neutral-900">{branding.appName}</span>
				</div>

				<section className="rounded-xl border border-neutral-200 bg-white p-6 shadow-xs sm:p-8">
					{steps && (
						<ol className="mb-6 flex flex-wrap gap-2 text-xs font-medium">
							{steps.map((step, index) => (
								<li key={step.label} className="flex items-center gap-2">
									<span
										aria-current={step.active ? "step" : undefined}
										className={
											step.active ? "rounded-md bg-blue-50 px-2 py-0.5 text-blue-900" : "px-2 py-0.5 text-neutral-500"
										}
									>
										{index + 1} {step.label}
									</span>
									{index < steps.length - 1 && <span className="text-neutral-300">/</span>}
								</li>
							))}
						</ol>
					)}
					<h1 className="text-xl font-semibold tracking-tight text-neutral-900">{title}</h1>
					{description && <p className="mt-1.5 text-sm leading-6 text-neutral-500">{description}</p>}
					<div className="mt-6 w-full">{children}</div>
					{footer && (
						<div className="mt-6 border-t border-neutral-200 pt-4 text-sm font-medium text-blue-700">{footer}</div>
					)}
				</section>
				<p aria-hidden="true" className="mt-8 text-center font-script text-3xl text-blue-600">
					Email that flows.
				</p>
			</main>
		</div>
	);
}
