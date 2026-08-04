/**
 * Executable MDX — public API.
 *
 * Treats markdown documents as durable workflows: text is emitted immediately,
 * component references are resolved and expanded recursively, and code blocks
 * marked as executable are run via durableExec.
 */

export type {
  ComponentExecution,
  FunctionComponent,
  FunctionComponentDefinition,
  Segment,
  TextSegment,
  ComponentElement,
  ExecutableCodeBlock,
  ExecOutputSegment,
  ErrorSegment,
  ExecResult,
  Modifier,
  ParsedInfoString,
  CodeBlockContext,
  CodeBlockResult,
  PropsSchema,
  ReturnsSchema,
  ComponentDefinition,
  ComponentFailure,
  ComponentInvocationMetadata,
  ComponentOrigin,
  PartialContent,
  ComponentRegistry,
  ComponentSelection,
  Registered,
  RegistryEntry,
  SampleContext,
  Json,
  JsonObject,
  SourcePosition,
} from "./src/types.ts";

export type { Workflow } from "@executablemd/durable-streams";
export { ephemeral } from "@executablemd/durable-streams";

export { healSegment } from "./src/heal.ts";

export type { Middleware } from "@effectionx/middleware";
export { combine } from "@effectionx/middleware";

export type { ModifierFactory, ModifierMiddleware, CodeBlockWorkflow } from "./src/modifiers.ts";
export { useCodeBlock } from "./src/modifiers.ts";

export type { ComponentApi } from "./src/component-api.ts";
export {
  Component,
  importComponent,
  applyModifiers,
  raise,
  env,
  evalScope,
  codeBlock,
  persistent,
  content,
  retain,
  invocation,
  tryContent,
  hasCapture,
  capture,
  handleFailure,
} from "./src/component-api.ts";

export { renderSegments } from "./src/render.ts";

export { createReplayStream } from "./src/replay-stream.ts";
export type { ReplayStream } from "./src/replay-stream.ts";

export type { EvalEnv } from "./src/types.ts";

export { compileBlock } from "./src/eval-context.ts";

export { matchPrompt, parseTemplate, PromptMismatchError } from "./src/template.ts";
export type { Captures, ParsedTemplate, TemplateToken } from "./src/template.ts";

export { Elicitation, ElicitationProviderError } from "./src/elicitation-api.ts";
export type { ElicitationApi, ElicitationRequest } from "./src/elicitation-api.ts";
export {
  elicit,
  ElicitValidationError,
  prepareElicitation,
  runPreparedElicitation,
} from "./src/elicit.ts";
export type { PreparedElicitation } from "./src/elicit.ts";

export { canonicalize, canonicalFingerprint } from "./src/canonical.ts";
export { isJsonObject } from "./src/json.ts";
export { walkSchema } from "./src/schema-walk.ts";
export type { NameKind, SchemaVisitor } from "./src/schema-walk.ts";

export { hasContent, useContent } from "./src/content-context.ts";
export { ContentError } from "./src/errors.ts";
export { InvocationTeardownError, withInvocation } from "./src/invocation.ts";
export type { Invocation } from "./src/invocation.ts";
export { Sample } from "./src/sample-api.ts";

export { evalFactory } from "./src/eval-handler.ts";
export { persistFactory } from "./src/modifiers/persist.ts";
export { timeoutFactory, parseDuration } from "./src/modifiers/timeout.ts";
export { daemonFactory } from "./src/modifiers/daemon.ts";

export { interpolateEvalBindings } from "./src/eval-interpolate.ts";

export { findFreePort } from "@executablemd/runtime";

export type { TransformResult } from "./src/eval-transform.ts";
export { transformBlock, serializeExports, isJson } from "./src/eval-transform.ts";

export { DocumentOutput } from "./src/api.ts";
export type { DocumentOutputApi } from "./src/api.ts";
export { useNormalizedOutput } from "./src/output/normalize.ts";
export { useTerminalOutput } from "./src/output/terminal.ts";

export { execute, Execution } from "./src/execute.ts";
export type {
  ExecuteOptions,
  ExecuteSettings,
  ExecutionApi,
  DocumentExecution,
} from "./src/execute.ts";
export { INLINE_SOURCE_PATH, inlineSource, rootSourcePath } from "./src/root-source.ts";
export type { InlineRootDocument, RootDocumentSource } from "./src/root-source.ts";
export { inspectComponent, inspectDocument } from "./src/inspect.ts";
export type {
  ComponentInfo,
  DocumentInfo,
  InspectComponentOptions,
  InspectOptions,
} from "./src/inspect.ts";

// Component registration — scope-local names resolved ahead of package defaults.
export { ComponentRegistrationError, registerComponents } from "./src/components/registration.ts";
export type { ComponentRegistration } from "./src/components/registration.ts";
export { DEFAULT_COMPONENT_DIRS, selectComponent } from "./src/components/select.ts";
export type { SelectOptions } from "./src/components/select.ts";
export { RESERVED_STRUCTURAL } from "./src/structural.ts";
export { printErrors } from "./src/component-failures.ts";
export { parseMarkdownDefinition } from "./src/definition.ts";
export { compileDataUri, useDataUriCompiler } from "./src/data-uri-compiler.ts";
export { compileTempFile, useTempFileCompiler } from "./src/temp-file-compiler.ts";

export { collect } from "./src/collect.ts";

export { validateBindingName } from "./src/expand.ts";
export {
  compilePropsSchema,
  compileReturnsSchema,
  validateProps,
  validateReturnValue,
  PropValidationError,
  PropsSchemaError,
  ReturnSchemaError,
  ReturnValidationError,
} from "./src/validate.ts";
export type { NormalizedIssue } from "./src/validate.ts";

// Agent components — <Agent>/<Session>/<Prompt> over a provider-factory seam.
export { installAgentComponents } from "./src/agent/components.ts";
export type { AgentComponentsOptions } from "./src/agent/components.ts";
export { Agent } from "./src/agent/agent-api.ts";
export type {
  AgentApi,
  AgentPromptEvent,
  PermissionMode,
  PermissionOption,
  PermissionOutcome,
  PermissionRequest,
  PromptOptions,
  Session,
} from "./src/agent/agent-api.ts";
export { AgentPromptError } from "./src/agent/errors.ts";
export { AgentProviders, registerAgentProvider } from "./src/agent/provider-api.ts";
export type {
  AgentProviderApi,
  AgentProviderFactory,
  AgentProviderOptions,
} from "./src/agent/provider-api.ts";
export {
  installApproveAll,
  installApproveReads,
  installAskPermission,
  installPermissionMode,
  installPromptFailurePolicy,
} from "./src/agent/permission.ts";

// Shared execution config — contextual timeout (re-exported from runtime).
export { Config, timeout } from "@executablemd/runtime";
export type { ConfigApi } from "@executablemd/runtime";

// Secret detection — the offline scanner and its safe findings.
// The rules themselves stay internal: they are policy, not API.
export { createSecretScanner } from "./src/secrets/scanner.ts";
export type { SecretScanner } from "./src/secrets/scanner.ts";
export { SecretDetectedError, SecretScannerError } from "./src/secrets/findings.ts";
export type { SecretFinding } from "./src/secrets/findings.ts";
export { scanFiles } from "./src/secrets/files.ts";
export type { FileSecretFinding } from "./src/secrets/files.ts";
