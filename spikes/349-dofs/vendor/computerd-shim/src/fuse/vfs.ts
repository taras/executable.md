// Type-only stub for the probe. Upstream vfs.ts line 7 is:
//   export type NodeVirtualFileSystem = VirtualFileSystem;
// The runtime wiring (prototype splice + EXTRA_VFS_METHODS forwarding)
// is hand-ported to wiring.mjs; shim.ts only imports this type.
export type { VirtualFileSystem as NodeVirtualFileSystem } from "@platformatic/vfs";
