import { randomBytes } from "node:crypto";

let lastMs = 0n;
let lastTail = 0n;

// RFC 9562 UUIDv7: 48-bit unix-ms timestamp + 4-bit version + 12-bit rand_a
// + 2-bit variant + 62-bit rand_b. Monotonic within the same millisecond by
// incrementing the random tail, which keeps generated IDs strictly sortable.
export function uuidv7(): string {
  let ms = BigInt(Date.now());
  const rand = randomBytes(10);
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

  const buf = Buffer.alloc(16);
  buf.writeUIntBE(Number(ms), 0, 6);
  buf[6] = 0x70 | Number((tail >> 72n) & 0x0fn);
  buf[7] = Number((tail >> 64n) & 0xffn);
  buf[8] = 0x80 | Number((tail >> 56n) & 0x3fn);
  buf[9] = Number((tail >> 48n) & 0xffn);
  buf[10] = Number((tail >> 40n) & 0xffn);
  buf[11] = Number((tail >> 32n) & 0xffn);
  buf[12] = Number((tail >> 24n) & 0xffn);
  buf[13] = Number((tail >> 16n) & 0xffn);
  buf[14] = Number((tail >> 8n) & 0xffn);
  buf[15] = Number(tail & 0xffn);

  const hex = buf.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
