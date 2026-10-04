import assert from "node:assert/strict";
import { test } from "node:test";
import { AnchorError, OTS_CONTENT_TYPE, OTS_MAX_RECEIPT_BYTES, otsFile, parseCalendars, submitToCalendar } from "./anchor.js";

const HASH = "bada982b06ff2be41df5572e348e0faa08f02065293fa918955868f67c0e9e42";

test("a proof file is the format header, the SHA-256 tag, the chain hash and the receipt", () => {
  const receipt = Uint8Array.from([0xf0, 0x10, 0x01, 0x02]);
  const file = otsFile(HASH, receipt);
  assert.equal(file.length, 31 + 2 + 32 + 4);
  assert.equal(Buffer.from(file.subarray(1, 15)).toString("latin1"), "OpenTimestamps");
  assert.equal(Buffer.from(file.subarray(17, 22)).toString("latin1"), "Proof");
  assert.deepEqual([...file.subarray(31, 33)], [0x01, 0x08]);
  assert.equal(Buffer.from(file.subarray(33, 65)).toString("hex"), HASH);
  assert.deepEqual([...file.subarray(65)], [...receipt]);
  assert.throws(() => otsFile("not-a-hash", receipt), AnchorError);
  assert.throws(() => otsFile(HASH.toUpperCase(), receipt), AnchorError);
});

test("a calendar is sent the 32 raw bytes and its answer is kept byte for byte", async () => {
  const seen: Array<{ url: string; body: Uint8Array; accept: string | null }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), body: new Uint8Array(init!.body as Uint8Array), accept: new Headers(init!.headers).get("accept") });
    return new Response(Uint8Array.from([9, 8, 7]), { status: 200 });
  }) as typeof fetch;
  const receipt = await submitToCalendar("https://calendar.example/", HASH, { fetchImpl });
  assert.deepEqual([...receipt], [9, 8, 7]);
  assert.equal(seen[0]!.url, "https://calendar.example/digest");
  assert.equal(Buffer.from(seen[0]!.body).toString("hex"), HASH);
  assert.equal(seen[0]!.accept, OTS_CONTENT_TYPE);
});

test("an answer that is not a receipt is refused", async () => {
  const respond = (body: Uint8Array, status = 200) => (async () => new Response(body, { status })) as typeof fetch;
  await assert.rejects(submitToCalendar("https://c.example", HASH, { fetchImpl: respond(new Uint8Array(0)) }), AnchorError);
  await assert.rejects(submitToCalendar("https://c.example", HASH, { fetchImpl: respond(new Uint8Array(OTS_MAX_RECEIPT_BYTES + 1)) }), AnchorError);
  await assert.rejects(submitToCalendar("https://c.example", HASH, { fetchImpl: respond(Uint8Array.from([1]), 503) }), /HTTP 503/);
  await assert.rejects(submitToCalendar("https://c.example", HASH, { fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch }), /Calendar request failed/);
});

test("the calendar list drops blanks, duplicates and anything that is not https", () => {
  assert.deepEqual(parseCalendars(" https://a.example/ , https://b.example,,http://c.example,https://a.example"), ["https://a.example", "https://b.example"]);
  assert.deepEqual(parseCalendars(""), []);
});
