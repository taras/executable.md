import { type Operation, until } from "effection";

export function* sha256Hex(bytes: Uint8Array): Operation<string> {
  const source = new Uint8Array(bytes);
  const digest = yield* until(crypto.subtle.digest("SHA-256", source.buffer));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function* fileSha256(path: string | URL): Operation<string> {
  return yield* sha256Hex(Deno.readFileSync(path));
}
