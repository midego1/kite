export interface ComposeAttachmentPolicy {
	maxMb: number;
	cloudThresholdBytes: number;
	/** Whether the From domain sends through Cloudflare, which turns files over the threshold into download links. */
	cloudLinks: boolean;
}
