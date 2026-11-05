export function jsonBytes(value: unknown, limit: number): number | undefined {
  const pending = [value];
  let bytes = 0;
  while (pending.length !== 0 && bytes <= limit) {
    const next = pending.pop();
    if (typeof next === "string") {
      if (next.length > limit) {
        return undefined;
      }
      bytes += new TextEncoder().encode(JSON.stringify(next)).length;
    } else if (Array.isArray(next)) {
      bytes += 2 + Math.max(0, next.length - 1);
      if (bytes > limit) {
        return undefined;
      }
      for (const member of next) {
        pending.push(member);
      }
    } else if (next !== null && typeof next === "object") {
      const entries = Object.entries(next).filter(([, member]) => member !== undefined);
      bytes += 2 + Math.max(0, entries.length - 1) + entries.length;
      if (bytes > limit) {
        return undefined;
      }
      for (const [key, member] of entries) {
        pending.push(key, member);
      }
    } else {
      bytes += next === undefined ? 4 : String(next).length;
    }
  }
  return bytes <= limit ? bytes : undefined;
}
