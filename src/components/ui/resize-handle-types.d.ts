export type ResizeHandleProps = {
	label: string;
	/** `horizontal` sits on the bottom edge and resizes height; the default resizes width from the right edge. */
	orientation?: "vertical" | "horizontal";
	onResizeStart?: () => void;
	onResize: (delta: number) => void;
	onResizeEnd?: () => void;
};
