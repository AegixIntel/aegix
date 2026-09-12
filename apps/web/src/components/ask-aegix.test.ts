import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AskAegix from "./ask-aegix";

test("Ask AEGIX renders the wallet explanation UI without an AI credential", () => {
  const html = renderToStaticMarkup(React.createElement(AskAegix, { wallet: "wallet" }));
  assert.match(html, /Ask AEGIX/); assert.match(html, /funding evidence/);
  assert.match(html, /cite evidence AEGIX never issued/);
});
test("Ask AEGIX renders market explanations separately from deterministic signals", () => {
  const html = renderToStaticMarkup(React.createElement(AskAegix, { wallet: "", market: "SOL" }));
  assert.match(html, /market observations/); assert.match(html, /<form/);
  assert.doesNotMatch(html, /BUY|SELL|LONG|SHORT/);
});
