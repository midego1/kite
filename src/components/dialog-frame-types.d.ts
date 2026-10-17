import type { HTMLAttributes } from "react";

export type DialogFrameProps = Omit<HTMLAttributes<HTMLDivElement>, "role" | "onKeyDown"> & {
	label: string;
	onClose: () => void;
};
