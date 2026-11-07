/** The part of a DataTransfer that a drag is judged by; a `DataTransferItemList` or a plain array both fit. */
export type DragPayload = {
	types?: ArrayLike<string> | Iterable<string>;
	items?: ArrayLike<{ kind: string }> | Iterable<{ kind: string }>;
};

/** The part of a clipboard or drag DataTransfer that the files are read from. */
export type ClipboardPayload = {
	types?: ArrayLike<string> | Iterable<string>;
	files?: ArrayLike<File> | Iterable<File>;
	items?: ArrayLike<{ kind: string; getAsFile(): File | null }> | Iterable<{ kind: string; getAsFile(): File | null }>;
	getData(format: string): string;
};
