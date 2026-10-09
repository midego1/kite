/**
 * R2 multipart uploads need every part except the last to have the same size,
 * so encoded backup chunks are re-cut into exact `partSize` slices here.
 */
export class FixedPartBuffer {
	private chunks: Uint8Array[] = [];
	private size = 0;

	constructor(readonly partSize: number) {
		if (!Number.isInteger(partSize) || partSize <= 0) throw new RangeError("partSize must be a positive integer");
	}

	get length(): number {
		return this.size;
	}

	push(bytes: Uint8Array): void {
		if (!bytes.byteLength) return;
		this.chunks.push(bytes);
		this.size += bytes.byteLength;
	}

	/** Removes and returns exactly `partSize` bytes, or null while fewer are buffered. */
	takePart(): Uint8Array | null {
		if (this.size < this.partSize) return null;
		return this.take(this.partSize);
	}

	/** Removes and returns everything still buffered. */
	takeRest(): Uint8Array {
		return this.take(this.size);
	}

	private take(length: number): Uint8Array {
		const out = new Uint8Array(length);
		let written = 0;
		while (written < length) {
			const chunk = this.chunks[0]!;
			const count = Math.min(chunk.byteLength, length - written);
			out.set(chunk.subarray(0, count), written);
			written += count;
			if (count === chunk.byteLength) this.chunks.shift();
			else this.chunks[0] = chunk.subarray(count);
		}
		this.size -= length;
		return out;
	}
}
