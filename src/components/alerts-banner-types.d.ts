export type BannerAlert = { rule: string; name: string; count: number; href: string };

export type ActiveAlertsResponse = { enabled: boolean; alerts: BannerAlert[]; signature: string | null };
