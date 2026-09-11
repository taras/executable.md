/**
 * SHA-256, in the language itself.
 *
 * Every host this package runs on has a SHA-256 already, and none of them has
 * one this code can use. `node:crypto` is a host specifier, and the whole point
 * of a shared module is that it names no host. `crypto.subtle.digest()` is
 * asynchronous, and the place this is needed most is inside a Durable Object's
 * synchronous transaction, where there is nothing to await into.
 *
 * So the arithmetic lives here. A content identity is what decides whether two
 * hosts are holding the same Workspace root, and a digest that differed between
 * them would be two systems quietly disagreeing about history. FIPS 180-4 is
 * fixed, small, and has published answers, which is why this is a reasonable
 * thing to carry: the tests hold it to those answers and to the identity the
 * Deno host computes with its own primitive.
 *
 * It hashes bytes already in memory. It is not a streaming interface and is not
 * for anything large; the private protocol bounds every piece it is used on.
 */

const INITIAL = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const ROUND = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotate(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function padded(input: Uint8Array): Uint8Array {
  const length = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(length);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const bits = BigInt(input.length) * 8n;
  for (let index = 0; index < 8; index += 1) {
    bytes[length - 1 - index] = Number((bits >> BigInt(index * 8)) & 0xffn);
  }
  return bytes;
}

export function sha256(value: Uint8Array | string): Uint8Array {
  const input = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const bytes = padded(input);
  const state = new Uint32Array(INITIAL);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const at = offset + index * 4;
      words[index] =
        ((bytes[at] ?? 0) << 24) |
        ((bytes[at + 1] ?? 0) << 16) |
        ((bytes[at + 2] ?? 0) << 8) |
        (bytes[at + 3] ?? 0);
    }
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15] ?? 0;
      const y = words[index - 2] ?? 0;
      const sigma0 = rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3);
      const sigma1 = rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10);
      words[index] = ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0;
    }
    let a = state[0] ?? 0;
    let b = state[1] ?? 0;
    let c = state[2] ?? 0;
    let d = state[3] ?? 0;
    let e = state[4] ?? 0;
    let f = state[5] ?? 0;
    let g = state[6] ?? 0;
    let h = state[7] ?? 0;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const first = (h + sum1 + choice + (ROUND[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const sum0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    state[0] = ((state[0] ?? 0) + a) >>> 0;
    state[1] = ((state[1] ?? 0) + b) >>> 0;
    state[2] = ((state[2] ?? 0) + c) >>> 0;
    state[3] = ((state[3] ?? 0) + d) >>> 0;
    state[4] = ((state[4] ?? 0) + e) >>> 0;
    state[5] = ((state[5] ?? 0) + f) >>> 0;
    state[6] = ((state[6] ?? 0) + g) >>> 0;
    state[7] = ((state[7] ?? 0) + h) >>> 0;
  }
  const digest = new Uint8Array(32);
  for (let index = 0; index < state.length; index += 1) {
    const word = state[index] ?? 0;
    digest[index * 4] = word >>> 24;
    digest[index * 4 + 1] = word >>> 16;
    digest[index * 4 + 2] = word >>> 8;
    digest[index * 4 + 3] = word;
  }
  return digest;
}

export function sha256Hex(value: Uint8Array | string): string {
  return Array.from(sha256(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
