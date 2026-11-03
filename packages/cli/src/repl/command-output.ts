export interface ReplCommandChunk {
  readonly channel: "stdout" | "stderr";
  readonly text: string;
}

export interface ReplCommandOutput {
  readonly entry: string;
  readonly chunks: readonly ReplCommandChunk[];
}

export function inertCommandText(text: string): string {
  return text.replace(
    /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g,
    (control) => `\\x${control.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}
