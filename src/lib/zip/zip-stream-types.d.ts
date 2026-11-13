/** One file of a streamed ZIP archive. */
export type ZipEntrySource = {
	/** The name inside the archive, already made safe (`uniqueZipEntryNames`); written as UTF-8. */
	name: string;
	/** Stored as the entry's MS-DOS modification time, in UTC. */
	modified: Date;
	/** Opens the body when the archive reaches this entry; throwing aborts the archive. */
	open: () => Promise<ReadableStream<Uint8Array>>;
};
