import { createContext } from "effection";
import type { Operation } from "effection";
import { registerFileRecorder } from "./files.ts";
import type { FilesHandler } from "./files.ts";
import type { FileRecorderHandle } from "./files-api.ts";
export type { FileRecorderHandle } from "./files-api.ts";
export { registerFileRecorder };
export const assembleFileCall = <K extends keyof FilesHandler>(
  handle: FileRecorderHandle,
  method: K,
): FilesHandler[K] => handle.assemble(method);

export type HostCopyRoute = (source: string, destination: string) => Operation<void>;

const HostCopyRouting = createContext<HostCopyRoute>("executablemd.runtime.host-copy-routing");

export function withHostCopyRoute<T>(route: HostCopyRoute, operation: Operation<T>): Operation<T> {
  return HostCopyRouting.with(route, () => operation);
}

export function* routeHostCopy(source: string, destination: string): Operation<void> {
  const route = yield* HostCopyRouting.get();
  if (route !== undefined) {
    yield* route(source, destination);
  }
}
