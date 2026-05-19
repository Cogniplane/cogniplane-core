// RFC 9562 UUIDv7. Uses Web Crypto so it works in browser, Edge runtime, and
// Cloudflare Workers. Monotonic within the same millisecond by incrementing
// the random tail, keeping generated IDs strictly sortable.
let lastMs = 0n;
let lastTail = 0n;

export function uuidv7(): string {
  let ms = BigInt(Date.now());
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);
  let tail =
    ((BigInt(rand[0]) & 0x0fn) << 72n) |
    (BigInt(rand[1]) << 64n) |
    (BigInt(rand[2]) << 56n) |
    (BigInt(rand[3]) << 48n) |
    (BigInt(rand[4]) << 40n) |
    (BigInt(rand[5]) << 32n) |
    (BigInt(rand[6]) << 24n) |
    (BigInt(rand[7]) << 16n) |
    (BigInt(rand[8]) << 8n) |
    BigInt(rand[9]);

  if (ms <= lastMs) {
    ms = lastMs;
    tail = lastTail + 1n;
    if (tail >> 76n) {
      ms += 1n;
      tail = 0n;
    }
  }
  lastMs = ms;
  lastTail = tail;

  const bytes = new Uint8Array(16);
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = 0x70 | Number((tail >> 72n) & 0x0fn);
  bytes[7] = Number((tail >> 64n) & 0xffn);
  bytes[8] = 0x80 | Number((tail >> 56n) & 0x3fn);
  bytes[9] = Number((tail >> 48n) & 0xffn);
  bytes[10] = Number((tail >> 40n) & 0xffn);
  bytes[11] = Number((tail >> 32n) & 0xffn);
  bytes[12] = Number((tail >> 24n) & 0xffn);
  bytes[13] = Number((tail >> 16n) & 0xffn);
  bytes[14] = Number((tail >> 8n) & 0xffn);
  bytes[15] = Number(tail & 0xffn);

  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
