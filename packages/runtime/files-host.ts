import { registerFileRecorder } from "./files.ts";
import type { FilesHandler } from "./files.ts";
import type { FileRecorderHandle } from "./files-api.ts";
export type { FileRecorderHandle } from "./files-api.ts";
export { registerFileRecorder };
export const assembleFileCall = <K extends keyof FilesHandler>(
  handle: FileRecorderHandle,
  method: K,
): FilesHandler[K] => handle.assemble(method);
