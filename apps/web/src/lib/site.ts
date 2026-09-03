/** Public site constants shared across the product and marketing surfaces. */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://aegix.app";

export const NAV_BRAND = "AEGIX";

export type MarketingLink = { label: string; href: string };

export const marketingNav: MarketingLink[] = [
  { label: "Product", href: "/#product" },
  { label: "Intelligence", href: "/#intelligence" },
  { label: "Developers", href: "/developers" },
  { label: "Methodology", href: "/methodology" },
  { label: "Docs", href: "/docs" }
];

export type AppNavItem = { label: string; href: string };

export const appOverviewNav: AppNavItem[] = [
  { label: "Wallet X-Ray", href: "/app/analyze" },
  { label: "Compare", href: "/app/compare" },
  { label: "Monitors", href: "/app/monitors" },
  { label: "Saved", href: "/app/saved" },
  { label: "Notifications", href: "/app/notifications" }
];

export const appDeveloperNav: AppNavItem[] = [
  { label: "API Keys", href: "/developers/api-keys" },
  { label: "Usage", href: "/developers/usage" },
  { label: "Webhooks", href: "/developers/webhooks" }
];

export const footerProductLinks: MarketingLink[] = [
  { label: "Wallet X-Ray", href: "/app/analyze" },
  { label: "Compare", href: "/app/compare" },
  { label: "Monitor", href: "/app/monitors" }
];

export const footerDeveloperLinks: MarketingLink[] = [
  { label: "API", href: "/developers" },
  { label: "Webhooks", href: "/developers/webhooks" },
  { label: "Docs", href: "/docs" }
];

export const footerResearchLinks: MarketingLink[] = [
  { label: "Methodology", href: "/methodology" },
  { label: "Security", href: "/security" }
];

export const footerCompanyLinks: MarketingLink[] = [
  { label: "About", href: "/#product" },
  { label: "Status", href: "/status" }
];
