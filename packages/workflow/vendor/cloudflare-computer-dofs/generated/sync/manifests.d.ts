import type { Database } from "../storage.js";
export interface ManifestChunk {
    hash: Uint8Array;
    size: number;
}
export declare const MANIFEST_VERSION = 1;
export declare function computeManifestHash(chunks: ManifestChunk[]): Uint8Array;
export declare function buildManifest(db: Database, chunks: ManifestChunk[], now: number): Uint8Array;
