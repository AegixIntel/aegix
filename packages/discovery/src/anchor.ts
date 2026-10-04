/**
 * External timestamps for the Discovery ID chain, through OpenTimestamps.
 *
 * The chain hash of a discovery commits to every discovery before it. Sending
 * that hash to a public calendar server gets back a receipt, and the calendar
 * later commits the hash to a Bitcoin block. From then on anyone holding the
 * receipt can check, without asking AEGIX, that the chain had reached that
 * discovery by the time of that block.
 *
 * What leaves AEGIX is one 32-byte hash. It says nothing about which series
 * a discovery relates.
 *
 * A receipt is pending until the calendar's block is mined, usually within a
 * few hours. Nothing here upgrades it: the standard client does
 * (`ots upgrade`), and the calendar keeps the pending commitment.
 */

/** "\x00OpenTimestamps\x00\x00Proof\x00" and the format's fixed magic bytes. */
const OTS_HEADER = Uint8Array.from([
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00,
  0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94
]);
const OTS_VERSION = 0x01;
/** The tag that says the stamped digest is a SHA-256. */
const OTS_OP_SHA256 = 0x08;

export const OTS_CONTENT_TYPE = "application/vnd.opentimestamps.v1";
/** A calendar's answer is a few hundred bytes. More than this is not a receipt. */
export const OTS_MAX_RECEIPT_BYTES = 8192;

export class AnchorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnchorError";
  }
}

function digestBytes(chainHash: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(chainHash)) throw new AnchorError("A chain hash is 64 lowercase hex characters");
  return Uint8Array.from(chainHash.match(/../g)!.map((byte) => parseInt(byte, 16)));
}

/**
 * The detached timestamp file for one receipt: what `ots verify -d <chain
 * hash>` and `ots upgrade` read.
 */
export function otsFile(chainHash: string, receipt: Uint8Array): Uint8Array {
  const digest = digestBytes(chainHash);
  const file = new Uint8Array(OTS_HEADER.length + 2 + digest.length + receipt.length);
  file.set(OTS_HEADER, 0);
  file[OTS_HEADER.length] = OTS_VERSION;
  file[OTS_HEADER.length + 1] = OTS_OP_SHA256;
  file.set(digest, OTS_HEADER.length + 2);
  file.set(receipt, OTS_HEADER.length + 2 + digest.length);
  return file;
}

/** Sends one chain hash to one calendar and returns its receipt. */
export async function submitToCalendar(
  calendarUrl: string,
  chainHash: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(`${calendarUrl.replace(/\/$/, "")}/digest`, {
      method: "POST", body: digestBytes(chainHash), signal: controller.signal,
      headers: { accept: OTS_CONTENT_TYPE, "content-type": "application/x-www-form-urlencoded" }
    });
    if (!response.ok) throw new AnchorError(`Calendar answered HTTP ${response.status}`);
    const receipt = new Uint8Array(await response.arrayBuffer());
    if (receipt.length === 0 || receipt.length > OTS_MAX_RECEIPT_BYTES) throw new AnchorError(`Calendar answered ${receipt.length} bytes, which is not a receipt`);
    return receipt;
  } catch (error) {
    if (error instanceof AnchorError) throw error;
    throw new AnchorError(controller.signal.aborted ? "Calendar did not answer in time" : "Calendar request failed");
  } finally { clearTimeout(timer); }
}

/** A comma-separated list of calendar URLs, as the configuration holds it. */
export function parseCalendars(value: string): string[] {
  return [...new Set(value.split(",").map((url) => url.trim().replace(/\/$/, "")).filter((url) => /^https:\/\/[^\s/]+/.test(url)))];
}
