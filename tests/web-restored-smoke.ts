import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";

async function main() {
  const entry = path.resolve("apps/web/.next/standalone/apps/web/server.js");
  assert.ok(existsSync(entry), "production standalone web build exists");
  const port = 18799;
  const child = spawn(process.execPath, [entry], { env: { ...process.env, NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: String(port) }, stdio: "ignore" });
  let started = false;
  try {
    for (let i = 0; i < 120; i++) {
      try { const response = await fetch(`http://127.0.0.1:${port}/markets`, { signal: AbortSignal.timeout(1000) }); if (response.ok) { started = true; break; } } catch { /* wait for this test's process */ }
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(started, "temporary production web process starts");
    for (const [route, texts] of [
      ["/app/context", ["Wallet Context", "Load context"]],
      ["/app/markets", ["Markets Intelligence", "BTC", "ETH", "SOL", "Load market"]],
      ["/markets", ["Open Markets", "Temporal correlation does not establish causation"]],
      ["/roadmap", ["SHIPPED", "Market Intelligence", "Narrative Radar", "Anomaly Detection"]],
      // Server-rendered shell only: plan, usage and invoice data arrive
      // client-side after an authenticated fetch.
      ["/app/billing", ["Plan &amp; usage", "Invoices", "No invoices yet"]],
      // Legal documents are static, fully server-rendered, and linked from every public page's footer.
      ["/terms", ["Terms of Service", "non-custodial", "AEGIX Developer", "Refund Policy"]],
      ["/privacy-policy", ["Privacy Policy", "AEGIX Developer", "Personal Data Protection Law"]],
      ["/refund", ["Refund Policy", "are not refundable", "Cancel at any time"]],
      ["/markets", ['href="/terms"', 'href="/privacy-policy"', 'href="/refund"']]
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 200, route);
      const html = await response.text();
      for (const text of texts) assert.ok(html.includes(text), `${route} renders ${text}`);
    }
    // The roadmap must agree with the shipped product state. The hand-written
    // list it replaced had Market Intelligence under NEXT while the navigation
    // called it LIVE, so that specific disagreement is asserted directly.
    const roadmapHtml = await fetch(`http://127.0.0.1:${port}/roadmap`, { signal: AbortSignal.timeout(10000) }).then((r) => r.text());
    const nextColumn = roadmapHtml.slice(roadmapHtml.indexOf(">NEXT<"), roadmapHtml.indexOf(">LATER<"));
    assert.ok(nextColumn.length > 0, "/roadmap renders a NEXT group before LATER");
    assert.ok(!nextColumn.includes("Market Intelligence"), "/roadmap does not file Market Intelligence under NEXT");
    console.log("D8/D10/D11 and roadmap production UI route rendering: PASS");
  } finally {
    if (child.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
  }
}
main().catch((error) => {
  // Report which assertion failed: a bare "FAIL" makes a route or copy
  // change indistinguishable from the server failing to start.
  console.error("Restored production UI route rendering: FAIL");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
