import type { Operation, Result } from "effection";
import type { FilePathInput } from "@executablemd/runtime";

export interface DirectoryPair {
  readonly source: string;
  readonly target: string;
}
export interface DirectoryFrame {
  readonly authoredDirectory: string;
  readonly actualDirectory: string;
  readonly namespace: "document" | "host";
  readonly interpreting: boolean;
  readonly selectedPair?: DirectoryPair;
}
export interface AuthoredFileOperation {
  readonly version: 1;
  readonly operation: "file-read" | "dir-ensure";
  readonly occurrence: string;
  readonly form: "self-closing" | "paired";
  readonly path: string;
  readonly directory: string;
  readonly namespace: "document" | "host";
  readonly destination: string;
}
export interface PreparedDirectory {
  readonly request: FilePathInput;
  readonly candidate: DirectoryFrame;
}
export interface FilesystemHost {
  readonly root: DirectoryFrame;
  prepareDirectory(
    authored: AuthoredFileOperation,
    enclosing: DirectoryFrame,
  ): Result<PreparedDirectory>;
  read(authored: AuthoredFileOperation, request: FilePathInput): Operation<Result<string>>;
  ensure(authored: AuthoredFileOperation, request: FilePathInput): Operation<Result<void>>;
}
export type FilesystemInstaller = (deliver: (host: FilesystemHost) => void) => Operation<void>;
