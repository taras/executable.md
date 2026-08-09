/**
 * Fixture for `local/prefer-effection-operation` — names that are not the
 * built-ins.
 *
 * A module that declares its own `Generator` at module level is talking about
 * that type throughout. The `globalThis` form reaches past the shadow, so it is
 * still reported.
 */

export interface Generator {
  render(template: string): string;
}

export interface AsyncGenerator {
  render(template: string): Promise<string>;
}

export type Render = (template: string) => Generator;

export type RenderAsync = (template: string) => AsyncGenerator;

export type Qualified = () => globalThis.Generator<unknown, void, unknown>;
