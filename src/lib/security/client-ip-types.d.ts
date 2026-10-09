export type ClientIpInput = {
	trustProxy: boolean;
	socketAddress: string | null | undefined;
	cfConnectingIp: string | null | undefined;
	forwardedFor: string | null | undefined;
};
