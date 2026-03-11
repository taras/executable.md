/**
 * Core types for Executable MDX.
 *
 * Defines the Segment intermediate representation, component model types,
 * modifier system types, and shared interfaces.
 */

// ---------------------------------------------------------------------------
// JSON-serializable value type
// ---------------------------------------------------------------------------

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

// ---------------------------------------------------------------------------
// Segment IR (spec §2.1)
// ---------------------------------------------------------------------------

export type Segment =
  | TextSegment
  | ComponentInvocation
  | ExecutableCodeBlock
  | ExecOutputSegment
  | ErrorSegment;

export interface TextSegment {
  type: "text";
  content: string;
}

export interface ComponentInvocation {
  type: "component";
  name: string;
  props: Record<string, Json>;
  children: Segment[];
  selfClosing: boolean;
}

export interface ExecutableCodeBlock {
  type: "codeBlock";
  language: string;
  content: string;
  modifiers: Modifier[];
  executable: true;
}

export interface ExecOutputSegment {
  type: "execOutput";
  command: string;
  result: ExecResult;
}

export interface ErrorSegment {
  type: "error";
  message: string;
  source?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// ---------------------------------------------------------------------------
// Modifier system (spec §3.2–3.5)
// ---------------------------------------------------------------------------

export interface ParsedInfoString {
  language: string;
  modifiers: Modifier[];
  executable: boolean;
}

export interface Modifier {
  name: string;
  params?: string;
}

export interface CodeBlockContext {
  language: string;
  content: string;
  blockId: string;
  componentName?: string;
}

export interface CodeBlockResult {
  output: string;
  exitCode: number;
  stderr: string;
}

// ---------------------------------------------------------------------------
// Component model (spec §4.1–4.3)
// ---------------------------------------------------------------------------

export interface InputDefinition {
  type: "string" | "number" | "boolean" | "array" | "object" | "any";
  default?: Json;
  required?: boolean;
  enum?: Json[];
  description?: string;
}

export interface ComponentDefinition {
  name: string;
  path: string;
  meta: Record<string, unknown>;
  inputs: Record<string, InputDefinition>;
  bodySegments: Segment[];
  contentHash: string;
}

export interface ImportResult {
  path: string;
  content: string;
  contentHash: string;
}

export interface ResolveResult {
  path: string;
}

// ---------------------------------------------------------------------------
// Sample Api context (spec §3.4)
// ---------------------------------------------------------------------------

export interface SampleContext {
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string;
  language: string;
  params?: string;
  componentName?: string;
}
