import { Err, Ok } from "effection";
import type { Result } from "effection";
import { posix, win32 } from "node:path";
import type { AuthoredFileOperation, DirectoryFrame, FilesystemHost } from "./filesystem-host.ts";

export interface FilesystemExpansion {
  readonly frame: DirectoryFrame;
  readonly host: FilesystemHost;
}
export interface HostPathArithmetic {
  readonly sep: string;
  join(...paths: string[]): string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
}
export class DocumentPathRepresentationError extends Error {
  override name = "DocumentPathRepresentationError";
  constructor() {
    super("This document path cannot be represented by this host.");
  }
}

export function authoredOperation(
  operation: AuthoredFileOperation["operation"],
  occurrence: string,
  path: string,
  frame: DirectoryFrame,
): AuthoredFileOperation {
  const namespace = path.startsWith("/")
    ? "document"
    : /^[a-zA-Z]:[\\\\/]/.test(path)
      ? "host"
      : frame.namespace;
  const arithmetic =
    namespace === "document"
      ? posix
      : /^[a-zA-Z]:[\\\\/]|^\\\\\\\\/.test(path) ||
          /^[a-zA-Z]:[\\\\/]|^\\\\\\\\/.test(frame.authoredDirectory)
        ? win32
        : posix;
  return Object.freeze({
    version: 1,
    operation,
    occurrence,
    form: operation === "file-read" ? "self-closing" : "paired",
    path,
    directory: frame.authoredDirectory,
    namespace: frame.namespace,
    destination: arithmetic.resolve(frame.authoredDirectory, path),
  });
}

export function admitDocumentHostPath(
  pathStyle: "posix" | "win32",
  operand: string,
  base: string,
  destination: string,
  hostAnchor: string,
  documentAnchor = "/",
  host: HostPathArithmetic = pathStyle === "win32" ? win32 : posix,
): Result<string> {
  const invalid = (value: string) =>
    value.includes("\0") ||
    (pathStyle === "win32" &&
      (/[\\\\:]/.test(value) ||
        value.split("/").some((part) => part !== "." && part !== ".." && /[. ]$/.test(part))));
  if (hostAnchor.includes("\0") || [operand, base, destination, documentAnchor].some(invalid)) {
    return Err(new DocumentPathRepresentationError());
  }
  const relative = posix.relative(documentAnchor, destination);
  const components = relative === "" ? [] : relative.split("/");
  if (components.some((part) => part === "" || part === "." || part === ".." || invalid(part))) {
    return Err(new DocumentPathRepresentationError());
  }
  const actual = host.join(hostAnchor, ...components);
  const observed = host.relative(hostAnchor, actual);
  const observedComponents = observed === "" ? [] : observed.split(host.sep);
  if (
    host.isAbsolute(observed) ||
    observedComponents.length !== components.length ||
    observedComponents.some((part, index) => part !== components[index])
  ) {
    return Err(new DocumentPathRepresentationError());
  }
  return Ok(actual);
}
