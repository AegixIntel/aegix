import assert from "node:assert/strict";
import { test } from "node:test";
import {
  products,
  roadmapGroups,
  primaryNav,
  siteRail,
  categoryProducts,
  productLineProducts,
  statusGroups,
  type ProductStatus
} from "./site.js";

/**
 * These assertions exist because the status surfaces drifted. Market
 * Intelligence was LIVE in the navigation and NEXT on the roadmap at the same
 * time, and nothing caught it: the lists were written by hand in four files
 * and no test compared them. They are now all derived from `products`, and
 * these tests keep the derivation honest.
 */

const GROUP_FOR_STATUS: Record<ProductStatus, string> = {
  LIVE: "SHIPPED",
  "IN DEVELOPMENT": "NEXT",
  PLANNED: "LATER",
  RESEARCH: "LATER"
};

function groupItems(label: string): string[] {
  const group = roadmapGroups.find((g) => g.label === label);
  assert.ok(group, `roadmap has a ${label} group`);
  return group.items.map((i) => i.name);
}

test("product ids and display names are unique", () => {
  assert.equal(new Set(products.map((p) => p.id)).size, products.length, "ids are unique");
  assert.equal(new Set(products.map((p) => p.name)).size, products.length, "names are unique");
});

test("a live product has an entry point, an unbuilt one does not pretend to", () => {
  for (const p of products) {
    if (p.status === "LIVE") {
      assert.ok(p.href && p.href.length > 0, `${p.id} is LIVE and has an href`);
    } else {
      // A planned capability gets no link rather than one that would 404.
      assert.equal(p.href, undefined, `${p.id} is ${p.status} and must not carry an href`);
    }
  }
});

test("every roadmap item names a real product and appears in exactly one group", () => {
  const seen = new Map<string, string>();
  for (const group of roadmapGroups) {
    for (const item of group.items) {
      const product = products.find((p) => p.name === item.name);
      if (!product) continue; // CURRENT holds workstreams, not products
      assert.equal(seen.get(item.name), undefined, `${item.name} appears once`);
      seen.set(item.name, group.label);
    }
  }

  for (const p of products.filter((p) => p.surfaces.includes("ROADMAP"))) {
    assert.ok(seen.has(p.name), `${p.name} is on the roadmap surface and in a group`);
    assert.equal(seen.get(p.name), GROUP_FOR_STATUS[p.status], `${p.name} sits under ${GROUP_FOR_STATUS[p.status]}`);
  }
});

test("no group outside SHIPPED claims a live product", () => {
  // The exact defect: Market Intelligence was in the nav as LIVE and under
  // NEXT on the roadmap.
  const shipped = groupItems("SHIPPED");
  for (const label of ["CURRENT", "NEXT", "LATER"]) {
    for (const name of groupItems(label)) {
      const product = products.find((p) => p.name === name);
      if (!product) continue;
      assert.notEqual(product.status, "LIVE", `${name} is LIVE and must not sit under ${label}`);
    }
  }
  assert.ok(shipped.includes("Market Intelligence"), "Market Intelligence is shipped, not next");
  assert.ok(!groupItems("NEXT").includes("Market Intelligence"), "Market Intelligence is not next");
});

test("CURRENT holds workstreams, not products", () => {
  const current = groupItems("CURRENT");
  assert.ok(current.length > 0, "CURRENT is not empty");
  for (const name of current) {
    assert.equal(products.find((p) => p.name === name), undefined, `${name} is not a product`);
  }
});

test("navigation statuses are taken from the product, never written by hand", () => {
  const navItems = [...primaryNav.flatMap((g) => g.items), ...siteRail];
  let checked = 0;
  for (const item of navItems) {
    if (!item.status) continue;
    assert.ok(item.productId, `${item.label} carries a status and names its product`);
    const product = products.find((p) => p.id === item.productId);
    assert.ok(product, `${item.label} references product ${item.productId}`);
    assert.equal(item.status, product.status, `${item.label} shows ${product.status}`);
    checked++;
  }
  assert.equal(checked, 8, "every status-bearing nav entry was checked");
});

test("landing surfaces resolve to products with a real status", () => {
  assert.ok(categoryProducts.length > 0, "the category strip has entries");
  assert.ok(productLineProducts.length > 0, "the product line has rows");
  for (const p of productLineProducts) {
    assert.ok(p.href.length > 0, `${p.id} product line row links somewhere`);
  }
  const groups = statusGroups("PRIVACY_PAGE");
  assert.ok(groups.length > 0, "the privacy page status list has entries");
  for (const group of groups) {
    assert.ok(group.items.length > 0, `${group.label} is not an empty column`);
  }
});
