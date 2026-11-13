/** One file of a streamed ZIP archive. */
export type ZipEntrySource = {
	/** The name inside the archive, already made safe (`uniqueZipEntryNames`); written as UTF-8. */
	name: string;
	/** The exact number of bytes `open`'s body delivers; any other count fails the archive. */
	size: number;
	/** The entry's modification time: DOS fields in UTC plus an extended timestamp. */
	modified: Date;
	/** Opens the body when the archive reaches this entry; throwing aborts the archive. */
	open: () => Promise<ReadableStream<Uint8Array>>;
};
