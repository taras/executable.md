export interface CanonicalPath {
    path: string;
    parts: string[];
    name: string;
    parentPath: string | undefined;
}
export declare function canonicalizePath(path: string): CanonicalPath;
