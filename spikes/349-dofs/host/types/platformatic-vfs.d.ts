// Typed facade for the @platformatic/vfs surface this spike consumes; the
// package ships CommonJS whose default-import shape differs by runtime, so
// the host normalizes at this boundary.

export interface VirtualFileSystem {
  provider: unknown;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
}

export declare class VirtualProvider {
  private brand;
}

declare const vfsModule: {
  create(
    provider: unknown,
    options?: { moduleHooks?: boolean },
  ): VirtualFileSystem;
  VirtualProvider: typeof VirtualProvider;
};

export default vfsModule;
