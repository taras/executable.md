/** The module `imported-generator.ts` takes its own `Generator` names from. */

export interface Generator {
  render(template: string): string;
}

export interface AsyncGenerator {
  render(template: string): Promise<string>;
}
