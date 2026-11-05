/** One adapter and the identity its bytes prove before execution. */
export interface EmbeddedAdapterSnapshot {
  readonly provider: string;
  readonly package: string;
  readonly version: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly base64: string;
}
