/** Public site constants shared across the product and marketing surfaces. */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://aegixintelligence.com";

export const NAV_BRAND = "AEGIX";

/** The operator named in the Terms of Service, Privacy Policy and Refund Policy. */
export const LEGAL_ENTITY = "AEGIX Developer";
export const LEGAL_EFFECTIVE_DATE = "14 September 2026";
/** Public contact for legal, privacy and billing questions; shown on the legal pages once set. */
export const LEGAL_CONTACT_EMAIL: string | null = null;

export const legalLinks = [
  { label: "Terms of Service", href: "/terms" },
  { label: "Privacy Policy", href: "/privacy-policy" },
  { label: "Refund Policy", href: "/refund" }
];

export type NavLinkItem = { label: string; href: string; status?: string };
export type NavGroup = { label: string; items: NavLinkItem[]; href?: string };

export const primaryNav: NavGroup[] = [
  {
    label: "Product",
    items: [
      { label: "Privacy Intelligence", href: "/privacy", status: "LIVE" },
      { label: "Market Intelligence", href: "/markets", status: "LIVE" },
      { label: "Wallet X-Ray", href: "/app/analyze" },
      { label: "Compare", href: "/app/compare" },
      { label: "Monitor", href: "/app/monitors" }
    ]
  },
  {
    label: "Intelligence",
    items: [
      { label: "Methodology", href: "/methodology" },
      { label: "Relationship Intelligence", href: "/intelligence" },
      { label: "Funding Provenance", href: "/intelligence#funding" },
      { label: "Behavioral Intelligence", href: "/intelligence#behavior" },
      { label: "Temporal Intelligence", href: "/intelligence#temporal" },
      { label: "Entity Intelligence", href: "/intelligence#entities" },
      { label: "Population Commonality", href: "/intelligence#commonality" }
    ]
  },
  {
    label: "Developers",
    items: [
      { label: "Developer Platform", href: "/developers" },
      { label: "API Reference", href: "/docs" },
      { label: "Webhooks", href: "/developers/webhooks" },
      { label: "Usage & Quotas", href: "/developers/usage" }
    ]
  }
];

export const docsNavLink: NavLinkItem = { label: "Docs", href: "/docs" };
export const roadmapNavLink: NavLinkItem = { label: "Roadmap", href: "/roadmap" };

/** Left sidebar menu for the public website. */
export const siteMenu: NavLinkItem[] = [
  { label: "Home", href: "/" },
  { label: "Products", href: "/privacy" },
  { label: "Intelligence", href: "/intelligence" },
  { label: "Methodology", href: "/methodology" },
  { label: "Docs", href: "/docs" },
  { label: "Roadmap", href: "/roadmap" },
  { label: "Security", href: "/security" },
  { label: "About", href: "/about" }
];

/** Product stops shown in the persistent desktop rail. */
export const siteRail: NavLinkItem[] = [
  { label: "Wallet X-Ray", href: "/app/analyze", status: "LIVE" },
  { label: "Attack", href: "/app/attack", status: "LIVE" },
  { label: "Compare", href: "/app/compare", status: "LIVE" },
  { label: "Monitor", href: "/app/monitors", status: "LIVE" },
  { label: "Developers", href: "/developers", status: "LIVE" },
  { label: "Market Intel", href: "/app/markets", status: "LIVE" }
];

/** Status-driven roadmap, shared by /roadmap and the landing page. */
export const roadmapGroups = [
  { label: "SHIPPED", items: ["Intelligence Core", "Wallet X-Ray", "Attack My Wallet", "Compare Intelligence", "Privacy Monitor", "Developer Intelligence API"] },
  { label: "CURRENT", items: ["Public Product Launch", "Multi-User Production", "Documentation", "Infrastructure Hardening"] },
  { label: "NEXT", items: ["Market Intelligence", "Narrative Radar", "Anomaly Detection", "Signal Engine"] },
  { label: "LATER", items: ["AI Intelligence Copilot", "Wallet Reputation", "Intelligence Network", "$AEX Economic Layer", "Multi-Chain"] }
];

export type AppNavItem = { label: string; href: string };
export type AppNavGroup = { label: string; items: AppNavItem[] };

export const appNavGroups: AppNavGroup[] = [
  {
    label: "Intelligence",
    items: [
      { label: "Wallet X-Ray", href: "/app/analyze" },
      { label: "Attack My Wallet", href: "/app/attack" },
      { label: "Compare", href: "/app/compare" },
      { label: "Monitors", href: "/app/monitors" },
      { label: "Wallet Context", href: "/app/context" },
      { label: "Markets", href: "/app/markets" }
    ]
  },
  {
    label: "Library",
    items: [
      { label: "Saved", href: "/app/saved" },
      { label: "Notifications", href: "/app/notifications" }
    ]
  },
  {
    label: "Account",
    items: [{ label: "Plan & usage", href: "/app/billing" }]
  },
  {
    label: "Developers",
    items: [
      { label: "API Keys", href: "/developers/api-keys" },
      { label: "Usage", href: "/developers/usage" },
      { label: "Webhooks", href: "/developers/webhooks" }
    ]
  }
];

export const footerColumns = [
  {
    title: "Product",
    links: [
      { label: "Wallet X-Ray", href: "/app/analyze" },
      { label: "Attack My Wallet", href: "/app/attack" },
      { label: "Compare", href: "/app/compare" },
      { label: "Privacy Monitor", href: "/app/monitors" },
      { label: "Market Intelligence", href: "/markets" }
    ]
  },
  {
    title: "Intelligence",
    links: [
      { label: "Methodology", href: "/methodology" },
      { label: "Funding", href: "/intelligence#funding" },
      { label: "Behavior", href: "/intelligence#behavior" },
      { label: "Correlation", href: "/intelligence" },
      { label: "Entities", href: "/intelligence#entities" }
    ]
  },
  {
    title: "Developers",
    links: [
      { label: "Docs", href: "/docs" },
      { label: "API Reference", href: "/docs" },
      { label: "Developer Platform", href: "/developers" },
      { label: "Webhooks", href: "/developers/webhooks" }
    ]
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "Roadmap", href: "/roadmap" },
      { label: "Security", href: "/security" },
      { label: "Status", href: "/status" }
    ]
  },
  {
    title: "Network",
    links: [{ label: "Solana", href: "/#network" }]
  }
];
