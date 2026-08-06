export const WORKERD_VERSION = "1.20260804.1";
export const COMPUTER_VERSION = "0.1.1";

export interface WorkerdBinary {
  npmPackage: string;
  tarballName: string;
  binaryEntry: string;
  sha256: string;
}

export const WORKERD_BINARIES: Record<string, WorkerdBinary> = {
  "darwin-aarch64": {
    npmPackage: "@cloudflare/workerd-darwin-arm64",
    tarballName: "workerd-darwin-arm64",
    binaryEntry: "package/bin/workerd",
    sha256: "02ffd9541af65bbe78a91c571b7eed1b75de242782153b88024d5e1ccdae6eb1",
  },
  "darwin-x86_64": {
    npmPackage: "@cloudflare/workerd-darwin-64",
    tarballName: "workerd-darwin-64",
    binaryEntry: "package/bin/workerd",
    sha256: "b21d9d023d37011f20493985f722a6597cfb6f08f30f5c9b3df35244f6f27757",
  },
  "linux-x86_64": {
    npmPackage: "@cloudflare/workerd-linux-64",
    tarballName: "workerd-linux-64",
    binaryEntry: "package/bin/workerd",
    sha256: "d1709383b9827e8003ed1b2a08f9fe2d12dd9c66b386a0907e428b7995e52f48",
  },
  "linux-aarch64": {
    npmPackage: "@cloudflare/workerd-linux-arm64",
    tarballName: "workerd-linux-arm64",
    binaryEntry: "package/bin/workerd",
    sha256: "fc807f6ac9b073a5d9fdf7f198c85967c2563a4d02ce2ab3e79c9356af64cb63",
  },
  "windows-x86_64": {
    npmPackage: "@cloudflare/workerd-windows-64",
    tarballName: "workerd-windows-64",
    binaryEntry: "package/bin/workerd.exe",
    sha256: "d4249851df97166512b915743fc595c7550c0ce34780e5cc1c7995fe68639ee3",
  },
};

export function hostPlatformKey(): string {
  return `${Deno.build.os}-${Deno.build.arch}`;
}

export function hostBinary(): WorkerdBinary {
  const key = hostPlatformKey();
  const binary = WORKERD_BINARIES[key];
  if (binary === undefined) {
    throw new Error(`no pinned workerd binary for platform ${key}`);
  }
  return binary;
}

export function tarballUrl(binary: WorkerdBinary): string {
  return `https://registry.npmjs.org/${binary.npmPackage}/-/${binary.tarballName}-${WORKERD_VERSION}.tgz`;
}
