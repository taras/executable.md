export type WorkspaceErrorCode =
  | "ENOENT"
  | "ENOTEMPTY"
  | "ENOTDIR"
  | "EISDIR"
  | "EEXIST"
  | "EINVAL"
  | "EACCES"
  | "EPERM"
  | "EROFS"
  | "ENOSYS"
  | "EBADF"
  | "ELOOP"
  | "EUNKNOWN_HASH"
  | "EIO";

export interface WorkspaceFsError extends Error {
  code: WorkspaceErrorCode;
  path?: string;
}

export function createWorkspaceError(
  code: WorkspaceErrorCode,
  message: string,
  path?: string,
): WorkspaceFsError {
  const error = new Error(path === undefined ? message : `${message}: ${path}`) as WorkspaceFsError;
  error.name = "WorkspaceFsError";
  error.code = code;
  error.path = path;
  return error;
}

export function invalidPath(path: string, reason: string): WorkspaceFsError {
  return createWorkspaceError("EINVAL", `Invalid path (${reason})`, path);
}
