/**
 * Fixture for `local/prefer-effection-operation` — an imported name that is not
 * the built-in.
 */
import type { AsyncGenerator, Generator } from "./generator-source.ts";

export type Render = (template: string) => Generator;

export type RenderAsync = (template: string) => AsyncGenerator;
