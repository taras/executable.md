import type { PromptImage } from "@executablemd/core/api";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { Operation } from "effection";
import { ReplHost } from "../host.ts";

const MAX_BYTES = 2 * 1024 * 1024;
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function* readPromptImage(
  workspace: string,
  path: string,
): Operation<{ image: PromptImage; sha256: string }> {
  const asset = yield* ReplHost.operations.readAsset(workspace, path, MAX_BYTES);
  const bytes = Buffer.from(asset.buffer, asset.byteOffset, asset.byteLength);
  if (!bytes.subarray(0, PNG_HEADER.length).equals(PNG_HEADER)) {
    throw new Error("Choose an imported PNG image.");
  }
  return {
    image: { mediaType: "image/png", data: bytes.toString("base64") },
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
