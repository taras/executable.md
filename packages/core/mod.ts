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
  applyBoundModifiers,
  applyModifiers,
  raise,
  env,
  evalScope,
  codeBlock,
  persistent,
  content,
  retain,
  tryContent,
  hasCapture,
  hasBinding,
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
export type {
  ComponentInvocation,
  FormDeclaration,
  FormRefusal,
  InvocationForm,
} from "./src/types.ts";
/**
 * Canonical definition construction for a package that registers a form-
 * sensitive component of its own.
 *
 * Not authority: what it returns runs only for an invocation this copy of core
 * minted, in the frame the engine is running, selected by canonical resolution
 * for that import. Building one proves nothing and grants nothing — it is the
 * normalization step, exposed so a package registering `<Dir>` normalizes at
 * the same boundary core's own defaults do.
 */
export { formDispatcher } from "./src/invocation-identity.ts";
/**
 * The opaque session placement a `<Session>` element routes. A handler reads its
 * descriptive name; only provider authority reads the engine identity.
 */
export { AgentSessionProtocolError, isSessionRequest } from "./src/agent/session-request.ts";
export type { AgentSessionRequest } from "./src/agent/session-request.ts";
export { ContentError } from "./src/errors.ts";
export { getExpansion } from "./src/expansion.ts";
export type { Expansion } from "./src/expansion.ts";
export { SOURCE_POSITION_FIELD, sourceDescription } from "./src/source-position.ts";
export { InvocationTeardownError, withInvocation } from "./src/invocation.ts";
export type { Invocation } from "./src/invocation.ts";
export { Sample } from "./src/sample-api.ts";
export { TestBehavior } from "./src/test-behavior.ts";
export type { TestBehaviorApi } from "./src/test-behavior.ts";
export { TestActivation } from "./src/test-activation.ts";
export type { TestActivationApi, TestActivationRequest } from "./src/test-activation.ts";

export { evalFactory } from "./src/eval-handler.ts";
export { persistFactory } from "./src/modifiers/persist.ts";
export { timeoutFactory } from "./src/modifiers/timeout.ts";
export { daemonFactory } from "./src/modifiers/daemon.ts";
export { EphemeralEvalOutputError, ephemeralFactory } from "./src/modifiers/ephemeral.ts";
export { serviceFactory } from "./src/modifiers/service.ts";
export {
  InvalidServiceBindingError,
  LiveBindingCollisionError,
  ServiceBindingCollisionError,
} from "./src/live-env.ts";

export { interpolateEvalBindings } from "./src/eval-interpolate.ts";

export type { TransformResult } from "./src/eval-transform.ts";
export { transformBlock, serializeExports, isJson } from "./src/eval-transform.ts";

export { DocumentOutput } from "./src/api.ts";
export type { DocumentOutputApi } from "./src/api.ts";
export { useNormalizedOutput } from "./src/output/normalize.ts";
export { useTerminalOutput } from "./src/output/terminal.ts";
export {
  createTerminalAuthority,
  createTerminalGridClaims,
  TerminalAuthorityError,
  terminalInstallation,
  useTerminalInstallation,
} from "./src/terminal/authority.ts";
export type {
  PaneReadiness,
  TerminalGridAuthority,
  TerminalGridClaims,
  TerminalPaneClaim,
} from "./src/terminal/authority.ts";
export {
  installTerminalProvider,
  registerTerminalProvider,
  TERMINAL_PROVIDERS_API,
  TerminalProviderInstallError,
  TerminalProviders,
} from "./src/terminal/provider-api.ts";
export type {
  TerminalProviderFactory,
  TerminalProviderInstallRequest,
  TerminalProviderOptions,
} from "./src/terminal/provider-api.ts";
export { installTerminalGridProfile } from "./src/terminal/profile.ts";
export type { TerminalGridProfileOptions } from "./src/terminal/profile.ts";
export { paneTerminal } from "./src/terminal/pane.ts";
export type { PaneTerminal } from "./src/terminal/pane.ts";
export type { PaneStatus, RetainedGrid, RetainedPaneOutcome } from "./src/terminal/grid.ts";

export { execute, Execution } from "./src/execute.ts";
export type {
  ExecuteOptions,
  ExecuteSettings,
  ExecutionApi,
  DocumentExecution,
} from "./src/execute.ts";
// The narrowing surface a middleware handler needs, and nothing that completes
// an execution: `executeInstalled` and `JournalAdmission` are host boundary.
export { ExecutionProtocolError } from "./src/execution-request.ts";
export type { CompletionFailure, ExecutionRequest } from "./src/execution-request.ts";
// The same division for document expansion: a handler receives a request and
// may refuse. Issuing one, the expansion it belongs to, claiming it and reading
// what canonical execution settled to are all internal.
export { DocumentProtocolError } from "./src/document-request.ts";
export type { DocumentRequest } from "./src/document-request.ts";
export {
  fileSource,
  formatDocumentReference,
  INLINE_SOURCE_PATH,
  inlineSource,
  retainedSource,
  rootSourcePath,
} from "./src/root-source.ts";
export type {
  FileRootDocument,
  InlineRootDocument,
  RetainedRootDocument,
  RootDocumentSource,
} from "./src/root-source.ts";
export {
  asDocumentTargetError,
  DocumentTargetError,
  isDocumentTargetError,
  // The one authority on what an exact target looks like. Exported under the
  // fuller name because a consumer outside this package — a stored workflow
  // definition validating the target it retained — reads it beside its own
  // vocabulary, where "target" alone would not say target of what.
  isCanonicalTarget as isCanonicalDocumentTarget,
  parseDocumentTargetFailure,
} from "./src/document-targets.ts";
export type {
  DocumentTargetErrorKind,
  DocumentTargetFailure,
  DocumentTargetInfo,
} from "./src/document-targets.ts";
export { inspectComponent, inspectDocument, inspectSyntax } from "./src/inspect.ts";
export type {
  CompleteComponentSyntaxEntry,
  ComponentInfo,
  DescribedContract,
  DocumentInfo,
  InspectComponentOptions,
  InspectOptions,
  InspectSyntaxOptions,
  OriginOnlyComponentSyntaxEntry,
  StructuralSyntaxEntry,
  SyntaxCatalog,
} from "./src/inspect.ts";
export { ComponentIncludeError } from "./src/components/candidates.ts";
// Document validation — one supplied document read as authored program
// structure, with nothing in it executed.
export {
  documentValidationCodeRank,
  validateDocument,
  validateDocumentStructure,
} from "./src/document-validation.ts";
export type {
  DocumentValidation,
  DocumentValidationCode,
  DocumentValidationDiagnostic,
  InvocationOpacityReason,
  InvocationSite,
  InvocationValidation,
  ValidateDocumentOptions,
  ValidateDocumentSettings,
} from "./src/document-validation.ts";

// Component registration — scope-local names resolved ahead of package defaults.
export {
  ComponentRegistrationError,
  isComponentName,
  registerComponents,
} from "./src/components/registration.ts";
export type { ComponentRegistration } from "./src/components/registration.ts";
export { DEFAULT_INCLUDES, selectComponent } from "./src/components/select.ts";
export type { SelectOptions } from "./src/components/select.ts";
export { CORE_COMPONENT_NAMES } from "./src/components/registry.ts";
export { RESERVED_STRUCTURAL, STRUCTURAL_DECLARATIONS } from "./src/structural.ts";
export type { StructuralDeclaration } from "./src/structural.ts";
export { documented, documentationOf } from "./src/components/documentation.ts";
export type {
  ComponentDocumentation,
  FirstPartyDocumentation,
} from "./src/components/documentation.ts";
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
export { validateParsed } from "./src/components/parse-schema.ts";

// Agent components — <Agent>/<Session>/<Prompt> over a provider-factory seam.
export {
  AGENT_REGISTRATIONS,
  agentIdentityComponents,
  installAgentComponents,
} from "./src/agent/components.ts";
export type { AgentComponentsOptions } from "./src/agent/components.ts";
export { Agent } from "./src/agent/agent-api.ts";
export type {
  AgentApi,
  AgentPromptEvent,
  LaunchOptions,
  PermissionMode,
  PermissionOption,
  PermissionOutcome,
  PermissionRequest,
  PromptOptions,
  Session,
  SessionLaunchResult,
} from "./src/agent/agent-api.ts";
export { AgentPromptError } from "./src/agent/errors.ts";
// Native session launch — the records one launch retains, and the request its
// public route carries. The authority that runs and retains a phase is not here
// and is not anywhere: it is delivered to the selected provider.
export { AgentLaunchError, sameExecutableBuild } from "./src/agent/launch.ts";
export type {
  DetachedLaunchRecord,
  ExecutableBuildBindingV1,
  ExitedLaunchRecord,
  IdentityProvenance,
  InstructionReconciliation,
  LaunchFailure,
  LaunchFailureClass,
  LaunchPhase,
  LaunchRecord,
  MaterializationPlan,
  MaterializationUsage,
  MaterializedLaunchRecord,
  PreparedLaunchRecord,
} from "./src/agent/launch.ts";
export { AgentLaunchProtocolError } from "./src/agent/launch-request.ts";
export type { AgentLaunchRequest } from "./src/agent/launch-request.ts";
export type { AgentLaunchPhases, AgentProviderAuthority } from "./src/agent/launch-authority.ts";
// The checkpoint type, because the authority's signature names it. The carrier
// itself is exported from nowhere: writing one is reachable only through a
// delivered authority, and reading one only from the prompt core is running.
export { AgentPromptCheckpointError } from "./src/agent/checkpoint.ts";
export type { AgentPromptCheckpoint } from "./src/agent/checkpoint.ts";
export { launchAgentSession } from "./src/agent/launch-install.ts";
export { AgentProviders, registerAgentProvider } from "./src/agent/provider-api.ts";
// `installAgentProvider` is deliberately absent: it takes a launch authority,
// and an authority reachable by import is an authority every package and every
// loaded copy can reach. An embedder installs a registered provider through
// `useProviderInstallation()`, which mints one and delivers it privately to the
// factory through this invocation's terminal.
export { useProviderInstallation } from "./src/agent/launch-install.ts";
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

// Shared execution config — the run deadline, the exec and Fetch defaults, and
// contextual verbosity, plus the one duration grammar the three timeouts are
// written in (re-exported from runtime).
export { Config, timeout, timeoutExec, timeoutFetch, verbose } from "@executablemd/runtime";
export { asDuration, durationError, parseDuration } from "@executablemd/runtime";
export type { ConfigApi } from "@executablemd/runtime";

// Secret detection — the offline scanner and its safe findings.
// The rules themselves stay internal: they are policy, not API.
export { createSecretScanner } from "./src/secrets/scanner.ts";
export type { SecretScanner } from "./src/secrets/scanner.ts";
export { SecretDetectedError, SecretScannerError } from "./src/secrets/findings.ts";
export type { SecretFinding } from "./src/secrets/findings.ts";
/**
 * The engine's `API.Files` door, for a component that does not live in core.
 *
 * `<Dir>` is the composition package's, and it performs a document filesystem
 * act like any other component. It must reach the Api the same way core's own
 * components do — through the call that converts an illegal throw into a
 * failure the engine can fence — rather than by holding the Api itself, which
 * is what "a provider may fail and may not throw" means in practice.
 */
export { ensureDirectory } from "./src/files.ts";

export { scanFiles } from "./src/secrets/files.ts";
export type { FileSecretFinding } from "./src/secrets/files.ts";

// The running execution's policy. Read-only by construction: what a caller can
// reach is a detached description and an execution-bound scan. The policy
// itself, its scanner, and the context it is bound in stay private, so nothing
// here can disable, replace, or outlive the detection an execution runs under.
export { scanSecrets, secretPolicy } from "./src/secrets/policy.ts";
export type { SecretPolicy } from "./src/secrets/policy.ts";
