/**
 * The two encodings the private protocol carries bytes and identities in.
 *
 * A WebSocket text frame carries text, and content-addressed bytes are not
 * text, so base64 is what the private protocol uses. It is canonical in both
 * directions: a value that decodes and then re-encodes to something else is
 * refused rather than accepted as though the difference did not matter, because
 * a digest is taken over bytes and two spellings of one byte sequence would be
 * two names for one piece of content.
 *
 * `bytesOf` is the storage side of the same question. SQLite hands back a blob
 * as whatever the runtime models one as, and a column that is not bytes at all
 * is damage rather than something to coerce.
 */

import { CommandError } from "./commands.ts";
export { sha256Hex } from "../workspace/sha256.ts";

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const stride = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += stride) {
    binary += String.fromCharCode(...bytes.slice(offset, offset + stride));
  }
  return btoa(binary);
}

export function decodeBase64(value: string): Uint8Array {
  if (value === "" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new CommandError("malformed-member");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new CommandError("malformed-member");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBase64(bytes) !== value) {
    throw new CommandError("malformed-member");
  }
  return bytes;
}

export function bytesOf(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }
  throw new Error("stored bytes are not a byte sequence");
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
