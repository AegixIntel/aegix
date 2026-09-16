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

export type NavLinkItem = {
  label: string;
  href: string;
  /** Always derived from `products` — never written by hand. */
  status?: ProductStatus;
  /** The product whose status this entry shows. */
  productId?: string;
};
export type NavGroup = { label: string; items: NavLinkItem[]; href?: string };

/* ------------------------------------------------------------------ */
/* Product status — the single source of truth                        */
/* ------------------------------------------------------------------ */

export type ProductStatus = "LIVE" | "IN DEVELOPMENT" | "PLANNED" | "RESEARCH";

/** Surfaces a product is presented on. Each surface derives its content from here. */
export type ProductSurface = "ROADMAP" | "CATEGORY" | "PRODUCT_LINE" | "PRIVACY_PAGE";

export interface Product {
  id: string;
  name: string;
  /**
   * The real entry point, and deliberately absent for anything unbuilt: a
   * planned capability has no route to link to, so it gets no href rather
   * than a link that would 404.
   */
  href?: string;
  status: ProductStatus;
  surfaces: ProductSurface[];
  /** Landing "Product line" copy. Only products carrying it appear there. */
  body?: string;
  /** The qualifier a bare status cannot carry, shown beside the item on /roadmap. */
  note?: string;
}

/**
 * This list is the only place a product's status is written down. The roadmap
 * groups, the landing status surfaces, the /privacy status list and the
 * navigation badges are all derived from it, so a product cannot be LIVE in
 * one place and NEXT in another. `apps/web/src/lib/site.test.ts` asserts the
 * derivation holds; the earlier hand-written copies had drifted into exactly
 * that contradiction.
 */
export const products: Product[] = [
  // Privacy pillar.
  { id: "privacy-intelligence", name: "Privacy Intelligence", href: "/privacy", status: "LIVE", surfaces: ["CATEGORY"] },
  {
    id: "wallet-x-ray",
    name: "Wallet X-Ray",
    href: "/app/analyze",
    status: "LIVE",
    surfaces: ["ROADMAP", "PRODUCT_LINE", "PRIVACY_PAGE"],
    body: "Understand what your public wallet activity may reveal."
  },
  {
    id: "attack-my-wallet",
    name: "Attack My Wallet",
    href: "/app/attack",
    status: "LIVE",
    surfaces: ["ROADMAP", "PRODUCT_LINE", "PRIVACY_PAGE"],
    body: "Follow observable paths through your on-chain activity."
  },
  {
    id: "compare-intelligence",
    name: "Compare Intelligence",
    href: "/app/compare",
    status: "LIVE",
    surfaces: ["ROADMAP", "PRODUCT_LINE", "PRIVACY_PAGE"],
    body: "Two wallets. One relationship model. Strength reported separately from confidence."
  },
  {
    id: "privacy-monitor",
    name: "Privacy Monitor",
    href: "/app/monitors",
    status: "LIVE",
    surfaces: ["ROADMAP", "PRODUCT_LINE", "PRIVACY_PAGE"],
    body: "Exposure changes. AEGIX notices."
  },
  { id: "wallet-context", name: "Wallet Context", href: "/app/context", status: "LIVE", surfaces: ["ROADMAP", "PRIVACY_PAGE"] },
  {
    id: "ask-aegix",
    name: "Ask AEGIX",
    href: "/app/context",
    status: "LIVE",
    surfaces: ["ROADMAP", "PRIVACY_PAGE"],
    note: "Embedded in Wallet Context and Markets; no standalone route. Requires a configured LLM provider, and answers are grounded in evidence AEGIX already issued."
  },

  // Platform.
  {
    id: "developer-intelligence-api",
    name: "Developer Intelligence API",
    href: "/developers",
    status: "LIVE",
    surfaces: ["ROADMAP", "PRODUCT_LINE"],
    body: "Scoped keys, metered quota, usage reporting, signed webhooks."
  },
  { id: "signed-webhooks", name: "Signed Webhooks", href: "/developers/webhooks", status: "LIVE", surfaces: ["ROADMAP"] },
  {
    id: "population-commonality",
    name: "Population Commonality",
    href: "/intelligence#commonality",
    status: "LIVE",
    surfaces: ["ROADMAP"],
    note: "Activates only when the AEGIX-observed population passes the sufficiency gate; the flag alone never enables it."
  },
  { id: "intelligence-core", name: "Intelligence Core", href: "/intelligence", status: "LIVE", surfaces: ["ROADMAP"] },

  // Markets. The shipped half is price and volume for three assets; the
  // sector, narrative and cross-market half has no engine and no data source.
  {
    id: "market-intelligence",
    name: "Market Intelligence",
    href: "/markets",
    status: "LIVE",
    surfaces: ["ROADMAP", "CATEGORY", "PRODUCT_LINE"],
    body: "BTC, ETH and SOL price, volume, bounded hourly history and deterministic signals.",
    note: "BTC, ETH and SOL only, over a bounded hourly window. Sector, ETF, narrative and cross-market analysis are not built."
  },
  { id: "narrative-radar", name: "Narrative Radar", status: "IN DEVELOPMENT", surfaces: ["ROADMAP"] },
  {
    id: "anomaly-detection",
    name: "Anomaly Detection",
    status: "IN DEVELOPMENT",
    surfaces: ["ROADMAP"],
    note: "Market-domain anomaly detection depends on a licensed historical data source that the repository does not yet have."
  },
  { id: "signal-engine", name: "Signal Engine", status: "IN DEVELOPMENT", surfaces: ["ROADMAP"] },
  { id: "cross-market-intelligence", name: "Cross-Market Intelligence", status: "IN DEVELOPMENT", surfaces: ["ROADMAP"] },

  // Later.
  { id: "ai-intelligence-copilot", name: "AI Intelligence Copilot", status: "PLANNED", surfaces: ["ROADMAP", "CATEGORY"] },
  {
    id: "wallet-reputation",
    name: "Wallet Reputation",
    status: "PLANNED",
    surfaces: ["ROADMAP"],
    note: "No labelled reputation dataset exists. Only the evidence-verification infrastructure is built."
  },
  { id: "intelligence-network", name: "Intelligence Network", status: "RESEARCH", surfaces: ["ROADMAP", "CATEGORY"] },
  { id: "aex-economic-layer", name: "$AEX Economic Layer", status: "PLANNED", surfaces: ["ROADMAP"] },
  { id: "multi-chain", name: "Multi-Chain", status: "PLANNED", surfaces: ["ROADMAP"] }
];

const PRODUCT_BY_ID = new Map(products.map((p) => [p.id, p]));

function product(id: string): Product {
  const found = PRODUCT_BY_ID.get(id);
  if (!found) throw new Error(`site.ts references unknown product id "${id}"`);
  return found;
}

function onSurface(surface: ProductSurface): Product[] {
  return products.filter((p) => p.surfaces.includes(surface));
}

/** A navigation entry that takes its status from the product it points at. */
function productNav(label: string, id: string, href?: string): NavLinkItem {
  const p = product(id);
  return { label, href: href ?? p.href ?? "/", status: p.status, productId: p.id };
}

/** Grouped status list for a single surface, empty buckets removed. */
export function statusGroups(surface: ProductSurface): Array<{ label: ProductStatus; items: string[] }> {
  const scoped = onSurface(surface);
  const order: ProductStatus[] = ["LIVE", "IN DEVELOPMENT", "PLANNED", "RESEARCH"];
  return order
    .map((status) => ({ label: status, items: scoped.filter((p) => p.status === status).map((p) => p.name) }))
    .filter((group) => group.items.length > 0);
}

/** Landing category strip: the pillar-level status line above the hero. */
export const categoryProducts = onSurface("CATEGORY");

/** Landing product line: the curated rows, in `products` order. */
export type LinkedProduct = Product & { href: string };

function linked(ps: Product[]): LinkedProduct[] {
  return ps.filter((p): p is LinkedProduct => Boolean(p.href));
}

export const productLineProducts = linked(onSurface("PRODUCT_LINE"));

/** Work that is under way but is not itself a product. */
const CURRENT_WORK = ["Public Product Launch", "Multi-User Production", "Documentation", "Infrastructure Hardening"];

export interface RoadmapItem {
  name: string;
  note?: string;
}

export interface RoadmapGroup {
  label: string;
  items: RoadmapItem[];
}

function roadmapItems(status: ProductStatus): RoadmapItem[] {
  return onSurface("ROADMAP")
    .filter((p) => p.status === status)
    .map((p) => ({ name: p.name, note: p.note }));
}

/**
 * Status-driven roadmap, derived from `products`. Shared by /roadmap and the
 * landing page, which is what makes the two agree by construction.
 */
export const roadmapGroups: RoadmapGroup[] = [
  { label: "SHIPPED", items: roadmapItems("LIVE") },
  { label: "CURRENT", items: CURRENT_WORK.map((name) => ({ name })) },
  { label: "NEXT", items: roadmapItems("IN DEVELOPMENT") },
  { label: "LATER", items: [...roadmapItems("PLANNED"), ...roadmapItems("RESEARCH")] }
];

export const primaryNav: NavGroup[] = [
  {
    label: "Product",
    items: [
      productNav("Privacy Intelligence", "privacy-intelligence"),
      productNav("Market Intelligence", "market-intelligence"),
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
  productNav("Wallet X-Ray", "wallet-x-ray"),
  productNav("Attack", "attack-my-wallet"),
  productNav("Compare", "compare-intelligence"),
  productNav("Monitor", "privacy-monitor", "/app/monitors"),
  productNav("Developers", "developer-intelligence-api"),
  productNav("Market Intel", "market-intelligence", "/app/markets")
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
      { label: "Markets", href: "/app/markets" },
      { label: "Network intelligence", href: "/app/network" }
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
