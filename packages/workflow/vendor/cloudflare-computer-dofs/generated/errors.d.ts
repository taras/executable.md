export type WorkspaceErrorCode = "ENOENT" | "ENOTEMPTY" | "ENOTDIR" | "EISDIR" | "EEXIST" | "EINVAL" | "EACCES" | "EPERM" | "EROFS" | "ENOSYS" | "EBADF" | "ELOOP" | "EUNKNOWN_HASH" | "EIO";
export interface WorkspaceFsError extends Error {
    code: WorkspaceErrorCode;
    path?: string;
}
export declare function createWorkspaceError(code: WorkspaceErrorCode, message: string, path?: string): WorkspaceFsError;
export declare function invalidPath(path: string, reason: string): WorkspaceFsError;
