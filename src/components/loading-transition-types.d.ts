import type { ReactNode } from "react";

export type LoadingTransitionProps = {
	children?: ReactNode;
	ready: boolean;
	/** Shown on the startup screen instead of the progress bar, which then stays up until it is cleared. */
	failure?: ReactNode;
};

export type StartupFailureProps = {
	onRetry(): void;
	onContinue(): void;
};

export type PageLoadingContextValue = {
	reportLoading(id: string, loading: boolean): void;
};
