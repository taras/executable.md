/**
 * 😵‍💫 This file has been vibe coded 😵‍💫
 */
import type { Help, MethodNotAllowed, RoutePath, UnprocessableContent, Version } from "./types.js";
export declare function printHelp<const H extends Help<RoutePath>>(intent: H): string;
export declare function printVersion<const V extends Version<RoutePath>>(intent: V): string;
export declare function printErrors(result: MethodNotAllowed | UnprocessableContent): string;
//# sourceMappingURL=print.d.ts.map