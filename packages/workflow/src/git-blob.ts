/**
 * The object id Git gives one blob, computed rather than asked for.
 *
 * A workflow definition names each bundled component by the object id of the
 * blob it was read from, and that id is identity: changing what a component
 * says changes the definition rather than changing what a retained definition
 * executes. Holding a retained history to that identity therefore means holding
 * the exact bytes it recorded to it — repeating the id beside unrelated bytes
 * establishes nothing about the bytes.
 *
 * A live run has the pinned source in hand and compares bytes with bytes. A
 * completed replay has no pinned source and no repository to ask, so it does
 * what Git does: frame the content as a blob object and name it. The framing is
 * Git's own — the kind, the number of bytes, a NUL, then the content — and the
 * number is the length of the *encoded* bytes rather than of the string, so a
 * document whose characters and bytes differ in number is named the way Git
 * names it.
 *
 * The arithmetic lives here for the reason `workspace/sha256.ts` gives for
 * carrying its own: every host has a SHA-1 already and none of them has one a
 * shared module can use. `node:crypto` names a host, and `crypto.subtle` is
 * asynchronous — and this runs inside canonical core's synchronous journal
 * admission, where there is nothing to await into. FIPS 180-4 is fixed, small
 * and has published answers, and the tests hold this to Git's own.
 */

import { sha256 } from "./workspace/sha256.ts";
import type { GitObjectFormat } from "./git.ts";

const INITIAL = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);

const ROUND = new Uint32Array([0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6]);

function rotate(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
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

/** The mixing function this round uses, by the quarter it falls in. */
function mixed(round: number, b: number, c: number, d: number): number {
  if (round < 20) {
    return (b & c) | (~b & d);
  }
  if (round < 40) {
    return b ^ c ^ d;
  }
  if (round < 60) {
    return (b & c) | (b & d) | (c & d);
  }
  return b ^ c ^ d;
}

export function sha1(value: Uint8Array | string): Uint8Array {
  const input = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const bytes = padded(input);
  const state = new Uint32Array(INITIAL);
  const words = new Uint32Array(80);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const at = offset + index * 4;
      words[index] =
        (((bytes[at] ?? 0) << 24) |
          ((bytes[at + 1] ?? 0) << 16) |
          ((bytes[at + 2] ?? 0) << 8) |
          (bytes[at + 3] ?? 0)) >>>
        0;
    }
    for (let index = 16; index < 80; index += 1) {
      words[index] = rotate(
        (words[index - 3] ?? 0) ^
          (words[index - 8] ?? 0) ^
          (words[index - 14] ?? 0) ^
          (words[index - 16] ?? 0),
        1,
      );
    }

    let a = state[0] ?? 0;
    let b = state[1] ?? 0;
    let c = state[2] ?? 0;
    let d = state[3] ?? 0;
    let e = state[4] ?? 0;
    for (let round = 0; round < 80; round += 1) {
      const mixture =
        (rotate(a, 5) +
          mixed(round, b, c, d) +
          e +
          (ROUND[Math.floor(round / 20)] ?? 0) +
          (words[round] ?? 0)) >>>
        0;
      e = d;
      d = c;
      c = rotate(b, 30);
      b = a;
      a = mixture;
    }
    state[0] = ((state[0] ?? 0) + a) >>> 0;
    state[1] = ((state[1] ?? 0) + b) >>> 0;
    state[2] = ((state[2] ?? 0) + c) >>> 0;
    state[3] = ((state[3] ?? 0) + d) >>> 0;
    state[4] = ((state[4] ?? 0) + e) >>> 0;
  }
  const digest = new Uint8Array(20);
  for (let index = 0; index < state.length; index += 1) {
    const word = state[index] ?? 0;
    digest[index * 4] = word >>> 24;
    digest[index * 4 + 1] = word >>> 16;
    digest[index * 4 + 2] = word >>> 8;
    digest[index * 4 + 3] = word;
  }
  return digest;
}

function hex(digest: Uint8Array): string {
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function sha1Hex(value: Uint8Array | string): string {
  return hex(sha1(value));
}

/** The separator Git writes between an object's header and its content. */
const NUL = "\u0000";

/**
 * The object id one blob has under a repository's object format.
 *
 * What `git hash-object -t blob` answers, and nothing else.
 */
export function gitBlobId(content: string, objectFormat: GitObjectFormat): string {
  const encoder = new TextEncoder();
  const body = encoder.encode(content);
  const header = encoder.encode(`blob ${body.length}${NUL}`);
  const framed = new Uint8Array(header.length + body.length);
  framed.set(header);
  framed.set(body, header.length);
  return objectFormat === "sha256" ? hex(sha256(framed)) : hex(sha1(framed));
}
