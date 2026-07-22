/**
 * Frontmatter interpolation: {meta.key} and {props.key} (spec §5.4).
 *
 * Runtime operation — deterministic from inputs, no journal entry.
 */

import type { Json } from "./types.ts";

/**
 * Replace `{meta.key}` and `{props.key}` references in text.
 *
 * Rules:
 * - Nested access via dot notation: `{meta.config.retry.count}`
 * - Missing key → empty string (no error)
 * - Arrays → comma-joined: `{meta.tags}` → `"alpha, beta"`
 * - Escaped braces: `\{not interpolated\}` → literal `{not interpolated}`
 */
export function interpolate(
  text: string,
  meta: Record<string, unknown>,
  props: Record<string, Json>,
): string {
  return text.replace(
    /\\?\{(meta|props)\.([^}]+)\}/g,
    (match, namespace: string, keyPath: string) => {
      // Escaped brace
      if (match.startsWith("\\")) {
        return match.slice(1);
      }

      const source =
        namespace === "meta"
          ? (meta as Record<string, unknown>)
          : (props as Record<string, unknown>);
      const value = getNestedValue(source, keyPath);

      if (value === undefined || value === null) {
        return "";
      }
      if (Array.isArray(value)) {
        return value.join(", ");
      }
      return String(value);
    },
  );
}

/**
 * Access a nested value via dot-separated path.
 */
export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce((current, key) => (current as Record<string, unknown>)?.[key], obj as unknown);
}
