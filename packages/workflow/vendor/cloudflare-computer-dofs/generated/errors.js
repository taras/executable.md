export function createWorkspaceError(code, message, path) {
    const error = new Error(path === undefined ? message : `${message}: ${path}`);
    error.name = "WorkspaceFsError";
    error.code = code;
    error.path = path;
    return error;
}
export function invalidPath(path, reason) {
    return createWorkspaceError("EINVAL", `Invalid path (${reason})`, path);
}
