import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const staticRoot = path.resolve("apps/web/.next/static");

async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const target = path.join(dir, entry.name);
    return entry.isDirectory() ? files(target) : [target];
  }));
  return nested.flat();
}

async function main(): Promise<void> {
  const assets = await files(staticRoot);
  assert.ok(assets.length > 0, "production static assets exist");
  for (const file of assets) {
    const content = await readFile(file, "utf8");
    assert.doesNotMatch(content, /http:\/\/api:3001|http:\/\/localhost:3001/, `${file} leaks a non-public API origin`);
  }
  console.log(`${assets.length} production web assets use same-origin API routing`);
}

void main();
