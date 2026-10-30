import { $ as measurePerf, $t as UnsupportedPromptContentError, Bt as AgentStartupError, C as textPrompt, Dt as normalizeOutputError, Et as isRetryablePromptError, F as normalizeName, G as normalizeAgentSessionId, Gt as PermissionDeniedError, H as canonicalAgentCommand, Ht as ClaudeAcpSessionCreateTimeoutError, Jt as SessionConfigOptionReplayError, K as SESSION_JOURNAL_SCHEMA, Kt as PermissionPromptUnavailableError, L as readSessionRecord, Lt as AcpxOperationalError, M as isoNow$1, O as absolutePath, Ot as extractAcpError, Q as incrementPerfCounter, Qt as SessionResumeRequiredError, R as resolveSessionRecord, Rt as AgentDisconnectedError, S as promptToDisplayText, St as isProcessAlive, T as lockOwnerPid, Tt as isAcpQueryClosedBeforeResponseError, Ut as CopilotAcpUnsupportedError, Vt as AuthPolicyError, W as extractAgentSessionId, Wt as GeminiAcpStartupTimeoutError, X as formatPerfMetric, Xt as SessionModelReplayError, Yt as SessionModeReplayError, Z as getPerfMetricsSnapshot, _ as ProcessDescendants, _t as sessionEventLockPath, a as trySetModelOnRunningOwner, at as isAcpMessageObject, d as releaseQueueOwnerLease, et as resetPerfMetrics, f as terminateProcess, ft as defaultSessionEventLog, g as QueueLeaseGuardSettlementError, gt as sessionEventActivePath, h as waitMs$1, ht as sessionBaseDir, i as trySetModeOnRunningOwner, it as isAcpJsonRpcMessage, j as findSessionByDirectoryWalk, k as findGitRepositoryRoot, kt as isAcpResourceNotFoundError, m as tryAcquireQueueOwnerLease, mt as retainedEventMaxSegments, n as tryCloseSessionOnRunningOwner, nt as startPerfTimer, o as trySubmitToRunningOwner, ot as isSessionUpdateNotification, p as terminateQueueOwnerForSession, pt as existingEventSegmentIndices, q as SessionJournalReader, qt as QueueConnectionError, r as trySetConfigOptionOnRunningOwner, s as SessionQueueOwner, t as tryCancelOnRunningOwner, tt as setPerfGauge, u as refreshQueueOwnerLease, vt as sessionEventSegmentPath, w as createLockOwner, wt as formatErrorMessage, y as getUnsupportedPromptContentMessage, z as writeSessionRecord, zt as AgentSpawnError } from "./ipc-BbYFsKOj.js";
import { A as requireAgentStdio, C as PROCESS_HELPER_TIMEOUT_MS, D as isoNow$2, E as isChildProcessRunning, F as waitForChildExit, I as waitForSpawn, M as resolveAgentSessionCwd, N as runTimedExecFile, P as splitCommandLine, T as basenameToken, _ as buildSpawnCommandOptions, b as readWindowsEnvValue, f as resolveBuiltInAgentLaunch, g as buildAgentSpawnCommand, j as resolveAgentCommandParts, v as buildTerminalShellSpawnCommand, w as asAbsoluteCwd, x as resolveWindowsExecutablePath, y as buildTerminalSpawnCommand } from "./agent-registry-Cz9fD9H1.js";
import fs, { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";
import fs$1 from "node:fs/promises";
import { appendRegularFile, appendRegularFileSync, withTempFile } from "@openclaw/fs-safe/advanced";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import { isHardlinkFallbackError } from "@openclaw/fs-safe/durability";
import { acquireFileLock } from "@openclaw/fs-safe/file-lock";
import { Readable, Writable } from "node:stream";
import { PROTOCOL_VERSION, RequestError, client, methods } from "@agentclientprotocol/sdk";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { isPathInside } from "@openclaw/fs-safe/path";
import { root } from "@openclaw/fs-safe/root";
import readline from "node:readline/promises";
// src/async-control.ts
var TimeoutError = class extends Error {
	constructor(timeoutMs) {
		super(`Timed out after ${timeoutMs}ms`);
		this.name = "TimeoutError";
	}
};
var InterruptedError = class extends Error {
	constructor() {
		super("Interrupted");
		this.name = "InterruptedError";
	}
};
function assertControlAuthority(authority) {
	authority?.signal?.throwIfAborted();
	authority?.assertActive?.();
}
async function withTimeout(promise, timeoutMs) {
	if (timeoutMs == null || timeoutMs <= 0) return await promise;
	let timer;
	const timeoutPromise = new Promise((_resolve, reject) => {
		timer = setTimeout(() => {
			reject(new TimeoutError(timeoutMs));
		}, timeoutMs);
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
async function withInterrupt(run, onInterrupt) {
	return await new Promise((resolve, reject) => {
		let settled = false;
		const finish = (cb) => {
			if (settled) return;
			settled = true;
			process.off("SIGINT", onSigint);
			process.off("SIGTERM", onSigterm);
			process.off("SIGHUP", onSighup);
			cb();
		};
		const rejectInterrupted = (signal) => {
			onInterrupt(signal).then(() => finish(() => reject(new InterruptedError())), (error) => finish(() => reject(error)));
		};
		const onSigint = () => {
			rejectInterrupted("SIGINT");
		};
		const onSigterm = () => {
			rejectInterrupted("SIGTERM");
		};
		const onSighup = () => {
			rejectInterrupted("SIGHUP");
		};
		process.once("SIGINT", onSigint);
		process.once("SIGTERM", onSigterm);
		process.once("SIGHUP", onSighup);
		run().then((result) => finish(() => resolve(result)), (error) => finish(() => reject(error)));
	});
}
// src/acp/codex-compat.ts
function isLegacyZedCodexAcpInvocation(agentCommand) {
	return /@zed-industries\/codex-acp\b/u.test(agentCommand);
}
function preferCodexPermissionRefusal(request, agentName) {
	if (agentName !== "@agentclientprotocol/codex-acp") return request;
	const preferred = request.options.find((option) => option.kind === "reject_once" && ["decline", "reject_permissions"].includes(option.optionId));
	return preferred ? {
		...request,
		options: [preferred, ...request.options.filter((option) => option !== preferred)]
	} : request;
}
function codexPermissionNotice(request, response, agentName) {
	if (agentName !== "@agentclientprotocol/codex-acp") return;
	if (response.outcome.outcome === "cancelled") return "No matching permission option was available. The request was safely cancelled; Codex may end the current turn.";
	const selectedId = response.outcome.optionId;
	return request.options.find((option) => option.optionId === selectedId)?.kind === "reject_once" && selectedId === "cancel" ? "Permission refused using Codex's cancellation option; this can end the current turn. The operation was not approved." : void 0;
}
// src/session/events.ts
async function ensureSessionDir() {
	await fs$1.mkdir(sessionBaseDir(), {
		recursive: true,
		mode: 448
	});
}
async function pathExists(filePath) {
	try {
		await fs$1.access(filePath);
		return true;
	} catch {
		return false;
	}
}
async function countExistingSegments(sessionId, maxSegments) {
	const limit = retainedEventMaxSegments(maxSegments);
	let count = (await existingEventSegmentIndices(sessionId)).filter((index) => index <= limit).length;
	if (await pathExists(sessionEventActivePath(sessionId))) count += 1;
	return count;
}
async function resolveInitialSegmentCount(record, maxSegments) {
	if (Number.isInteger(record.eventLog.segment_count) && record.eventLog.segment_count > 0) return record.eventLog.segment_count;
	return await countExistingSegments(record.acpxRecordId, maxSegments) || 1;
}
async function resolveSessionMaxSegments(sessionId) {
	try {
		const configured = (await resolveSessionRecord(sessionId)).eventLog.max_segments;
		const retained = retainedEventMaxSegments(configured);
		if (retained > 0) return retained;
	} catch {}
	return 5;
}
async function rotateSegments(sessionId, maxSegments) {
	const limit = retainedEventMaxSegments(maxSegments);
	if (limit < 1) return;
	await discardOverflowSegment(sessionId, limit);
	await shiftRetainedSegments(sessionId, limit);
	await promoteActiveSegment(sessionId);
}
async function discardOverflowSegment(sessionId, limit) {
	if (!(await existingEventSegmentIndices(sessionId)).includes(limit)) return;
	await fs$1.unlink(sessionEventSegmentPath(sessionId, limit)).catch((error) => {
		if (error.code !== "ENOENT") throw error;
	});
}
async function shiftRetainedSegments(sessionId, limit) {
	const movable = (await existingEventSegmentIndices(sessionId)).filter((index) => index < limit).toSorted((left, right) => right - left);
	for (const segment of movable) {
		const from = sessionEventSegmentPath(sessionId, segment);
		if (!await pathExists(from)) continue;
		const next = segment + 1;
		if (!Number.isSafeInteger(next)) throw new Error("Session journal segment index exceeds its supported range");
		await fs$1.rename(from, sessionEventSegmentPath(sessionId, next));
	}
}
async function promoteActiveSegment(sessionId) {
	const active = sessionEventActivePath(sessionId);
	if (await pathExists(active)) await fs$1.rename(active, sessionEventSegmentPath(sessionId, 1));
}
var SessionEventWriter = class SessionEventWriter {
	record;
	maxSegmentBytes;
	maxSegments;
	activePath;
	activeSizeBytes;
	segmentCount;
	closed = false;
	pending = Promise.resolve();
	appendFailure;
	sequence;
	requestId;
	recoveryPending;
	needsAnchor;
	needsRotation;
	activeEntries;
	constructor(record, options, state) {
		this.record = record;
		this.maxSegmentBytes = options.maxSegmentBytes;
		this.maxSegments = options.maxSegments;
		this.activePath = state.activePath;
		this.activeSizeBytes = state.activeSizeBytes;
		this.segmentCount = state.segmentCount;
		this.sequence = state.sequence;
		this.requestId = state.requestId;
		this.recoveryPending = state.requestId !== null;
		this.needsAnchor = !state.anchored;
		this.needsRotation = state.activeSizeBytes > 0 && (!state.anchored || state.partial);
		this.activeEntries = state.anchored ? 1 : 0;
	}
	static async open(record, options = {}) {
		const maxSegmentBytes = options.maxSegmentBytes ?? record.eventLog.max_segment_bytes ?? 67108864;
		const maxSegments = retainedEventMaxSegments(options.maxSegments ?? record.eventLog.max_segments ?? 5);
		const activePath = sessionEventActivePath(record.acpxRecordId);
		const tail = await new SessionJournalReader({
			...record,
			eventLog: {
				...record.eventLog,
				max_segments: maxSegments
			}
		}).readTail();
		if (tail.messageSequence !== void 0) record.lastSeq = tail.messageSequence;
		const segmentCount = await resolveInitialSegmentCount(record, maxSegments);
		return new SessionEventWriter(record, {
			maxSegmentBytes,
			maxSegments
		}, {
			activePath,
			activeSizeBytes: tail.activeSize,
			segmentCount,
			sequence: tail.sequence,
			requestId: tail.requestId,
			anchored: tail.activeAnchored,
			partial: tail.activePartial
		});
	}
	getRecord() {
		return this.record;
	}
	enqueue(run) {
		if (this.closed) return Promise.reject(/* @__PURE__ */ new Error("SessionEventWriter is closed"));
		const operation = this.pending.then(run);
		this.pending = operation.catch(() => {});
		return operation;
	}
	async beginTurn(requestId) {
		if (!requestId) throw new Error("Session journal request ID must not be empty");
		await this.enqueue(async () => {
			if (this.requestId !== null) {
				if (!this.recoveryPending) throw new Error("A session journal turn is already active");
				await this.appendEntry({
					schema: SESSION_JOURNAL_SCHEMA,
					type: "turn_result",
					request_id: this.requestId,
					result: {
						status: "failed",
						error: {
							message: "The previous owner ended without recording a settled result; the turn outcome is unknown.",
							detailCode: "WATCH_OUTCOME_UNKNOWN",
							retryable: false
						}
					}
				});
				this.requestId = null;
			}
			this.recoveryPending = false;
			await this.appendEntry({
				schema: SESSION_JOURNAL_SCHEMA,
				type: "turn_started",
				request_id: requestId
			});
			this.requestId = requestId;
		});
	}
	async finishTurn(requestId, result) {
		await this.enqueue(async () => {
			if (requestId !== this.requestId) throw new Error("Session journal result does not match the active request");
			await this.appendEntry({
				schema: SESSION_JOURNAL_SCHEMA,
				type: "turn_result",
				request_id: requestId,
				result
			});
			this.requestId = null;
		});
	}
	async appendMessage(message, options = {}) {
		await this.appendMessages([message], options);
	}
	async appendMessages(messages, options = {}) {
		await this.enqueue(async () => {
			await measurePerf("session.events.append_batch", async () => {
				for (const message of messages) {
					if (!isAcpJsonRpcMessage(message)) throw new Error("Attempted to persist invalid ACP JSON-RPC payload");
					await this.appendEntry(message);
					this.record.lastSeq += 1;
					if (Object.hasOwn(message, "id")) {
						const id = message.id;
						if (typeof id === "string" || typeof id === "number") this.record.lastRequestId = String(id);
					}
				}
			});
			if (options.checkpoint === true) await writeSessionRecord(this.record);
		});
	}
	async appendEntry(entry) {
		if (this.appendFailure) throw this.appendFailure.error;
		try {
			await this.writeEntry(entry);
		} catch (error) {
			this.appendFailure = { error };
			throw error;
		}
	}
	async writeEntry(entry) {
		if (!Number.isSafeInteger(this.sequence + 1)) throw new Error("Session journal sequence exceeds its supported range");
		await ensureSessionDir();
		const line = `${JSON.stringify(entry)}\n`;
		const lineBytes = Buffer.byteLength(line);
		if (this.needsRotation || this.activeEntries > 0 && this.activeSizeBytes + lineBytes > this.maxSegmentBytes) {
			await rotateSegments(this.record.acpxRecordId, this.maxSegments);
			this.activeSizeBytes = 0;
			this.activeEntries = 0;
			this.needsAnchor = true;
			this.needsRotation = false;
			this.segmentCount = Math.min(this.segmentCount + 1, this.maxSegments);
			incrementPerfCounter("session.events.rotate");
		}
		if (this.needsAnchor) {
			const anchor = {
				schema: SESSION_JOURNAL_SCHEMA,
				type: "segment",
				record_id: this.record.acpxRecordId,
				sequence: this.sequence,
				message_sequence: this.record.lastSeq,
				request_id: this.requestId
			};
			const header = `${JSON.stringify(anchor)}\n`;
			await appendRegularFile({
				filePath: this.activePath,
				content: header,
				mode: 384
			});
			this.activeSizeBytes += Buffer.byteLength(header);
			this.needsAnchor = false;
		}
		await appendRegularFile({
			filePath: this.activePath,
			content: line,
			mode: 384
		});
		this.activeSizeBytes += lineBytes;
		this.activeEntries += 1;
		this.sequence += 1;
		const writeTs = (/* @__PURE__ */ new Date()).toISOString();
		this.record.lastUsedAt = writeTs;
		this.record.eventLog = {
			active_path: this.activePath,
			segment_count: this.segmentCount,
			max_segment_bytes: this.maxSegmentBytes,
			max_segments: this.maxSegments,
			last_write_at: writeTs,
			last_write_error: null
		};
	}
	async checkpoint() {
		await this.enqueue(async () => await writeSessionRecord(this.record));
	}
	async close(options = {}) {
		if (this.closed) return;
		this.closed = true;
		await this.pending;
		if (this.appendFailure) throw this.appendFailure.error;
		if (options.checkpoint !== false) await writeSessionRecord(this.record);
	}
};
async function listSessionEvents(sessionId, maxSegments) {
	maxSegments = retainedEventMaxSegments(maxSegments ?? await resolveSessionMaxSegments(sessionId));
	return await new SessionJournalReader({
		acpxRecordId: sessionId,
		eventLog: { max_segments: maxSegments }
	}).readAcpMessages();
}
// src/session/turn-ownership.ts
const LOCK_RETRY_MS = 15;
const INCOMPLETE_RESERVATION_GRACE_MS = 15e3;
let lastCreatedAt = 0;
const localTurns = /* @__PURE__ */ new Map();
async function readLock(filePath) {
	try {
		const stat = await fs$1.lstat(filePath, { bigint: true });
		if (!stat.isFile()) throw new Error(`Session turn lock is not a regular file: ${filePath}`);
		return {
			stat,
			payload: await fs$1.readFile(filePath, "utf8")
		};
	} catch (error) {
		if (error.code === "ENOENT") return;
		throw error;
	}
}
function parseLock(payload) {
	try {
		return JSON.parse(payload);
	} catch {
		return;
	}
}
async function tryAcquireGuard(filePath, owner, signal) {
	try {
		return await acquireFileLock(filePath, {
			managerKey: "acpx.session-turn",
			lockPath: `${filePath}.guard`,
			staleMs: Infinity,
			timeoutMs: LOCK_RETRY_MS,
			retry: {
				retries: 8,
				minTimeout: 1,
				maxTimeout: 2,
				factor: 1,
				randomize: false
			},
			staleRecovery: "remove-if-unchanged",
			payload: () => owner.payload,
			shouldReclaim: ({ payload }) => owner.hasExited(payload, false, signal),
			shouldRemoveStaleLock: ({ payload }) => owner.hasExited(payload, true, signal)
		});
	} catch (error) {
		if (error.code === "file_lock_timeout") return;
		throw error;
	}
}
async function removeObservedLock(filePath, observed) {
	const current = await readLock(filePath);
	if (!current) return true;
	if (current.payload !== observed.payload || current.stat.mtimeNs !== observed.stat.mtimeNs || current.stat.size !== observed.stat.size) return false;
	await fs$1.unlink(filePath).catch((error) => {
		if (error.code !== "ENOENT") throw error;
	});
	return true;
}
async function recoverAbandonedLock(filePath, owner, signal) {
	const observed = await readLock(filePath);
	if (!observed) return true;
	const payload = parseLock(observed.payload);
	const pid = lockOwnerPid(payload);
	if (pid && (!await owner.hasExited(payload, false, signal) || !await owner.hasExited(payload, true, signal))) return false;
	if (!pid && Date.now() - Number(observed.stat.mtimeMs) <= INCOMPLETE_RESERVATION_GRACE_MS) return false;
	if (await removeObservedLock(filePath, observed)) {
		incrementPerfCounter("session.events.stale_lock_recovered");
		return true;
	}
	return false;
}
async function publishLock(filePath, payload, signal) {
	await withTempFile({
		rootDir: path.dirname(filePath),
		prefix: "session-turn",
		fileName: "lock"
	}, async (temporaryPath) => {
		await fs$1.writeFile(temporaryPath, payload, {
			encoding: "utf8",
			flag: "wx",
			mode: 384
		});
		signal?.throwIfAborted();
		try {
			await fs$1.link(temporaryPath, filePath);
		} catch (error) {
			if (!isHardlinkFallbackError(error)) throw error;
			await fs$1.writeFile(filePath, payload, {
				encoding: "utf8",
				flag: "wx",
				mode: 384
			});
		}
	});
}
async function removePublishedLock(filePath, payload) {
	const current = await readLock(filePath);
	if (current?.payload === payload) await removeObservedLock(filePath, current);
}
async function rejectAcquisition(filePath, receipt, error) {
	const failures = [error];
	await disposeTurn(filePath, receipt).catch((cleanupError) => {
		failures.push(...cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError]);
	});
	if (failures.length > 1) throw new AggregateError(failures, "Session turn acquisition and cleanup failed");
	throw error;
}
async function releaseTurnGuard(receipt) {
	await receipt.guard?.release();
	receipt.guard = void 0;
}
async function removeTurnMarker(filePath, receipt) {
	if (!receipt.removeMarker) return true;
	if (receipt.guard && !await receipt.guard.verifyStillHeld()) await releaseTurnGuard(receipt);
	receipt.guard ??= await tryAcquireGuard(filePath, receipt.owner);
	if (!receipt.guard) return false;
	await receipt.removeMarker();
	receipt.removeMarker = void 0;
	return true;
}
async function settleTurn(filePath, receipt) {
	if (receipt.settled) return true;
	const pending = receipt.pending ??= (async () => {
		receipt.failed = false;
		const failures = [];
		try {
			if (!await removeTurnMarker(filePath, receipt)) return false;
		} catch (error) {
			failures.push(error);
		}
		if (failures.length === 0 || !receipt.admitted) try {
			await releaseTurnGuard(receipt);
		} catch (error) {
			failures.push(error);
		}
		if (failures.length > 1) throw new AggregateError(failures, "Session turn cleanup failed");
		if (failures.length === 1) throw failures[0];
		receipt.settled = true;
		localTurns.delete(filePath);
		return true;
	})();
	try {
		return await pending;
	} finally {
		if (receipt.pending === pending) {
			receipt.pending = void 0;
			receipt.failed = !receipt.settled;
		}
	}
}
async function disposeTurn(filePath, receipt) {
	if (!await settleTurn(filePath, receipt)) throw new Error(`Session turn cleanup is waiting for its guard: ${filePath}`);
}
async function tryPublishLock(filePath, payload, owner, signal) {
	for (;;) try {
		await publishLock(filePath, payload, signal);
		return true;
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		if (!await recoverAbandonedLock(filePath, owner, signal)) return false;
	}
}
async function tryAcquireTurnCleanup(filePath, payload, owner, signal) {
	const previous = localTurns.get(filePath);
	if (previous) {
		if (previous.failed) await settleTurn(filePath, previous);
		return;
	}
	const receipt = {
		owner,
		removeMarker: async () => await removePublishedLock(filePath, payload),
		admitted: false,
		failed: false,
		settled: false
	};
	localTurns.set(filePath, receipt);
	try {
		receipt.guard = await tryAcquireGuard(filePath, owner, signal);
	} catch (error) {
		localTurns.delete(filePath);
		throw error;
	}
	if (!receipt.guard) {
		localTurns.delete(filePath);
		return;
	}
	return receipt;
}
async function tryAcquireTurn(filePath, payload, owner, signal) {
	const receipt = await tryAcquireTurnCleanup(filePath, payload, owner, signal);
	if (!receipt) return;
	try {
		signal?.throwIfAborted();
		if (!await tryPublishLock(filePath, payload, owner, signal)) {
			await disposeTurn(filePath, receipt);
			return;
		}
		const observed = await readLock(filePath);
		if (observed?.payload !== payload) throw new Error(`Session turn ownership changed before admission: ${filePath}`);
		signal?.throwIfAborted();
		receipt.admitted = true;
		receipt.removeMarker = async () => await removeObservedLock(filePath, observed);
		return { [Symbol.asyncDispose]: async () => await disposeTurn(filePath, receipt) };
	} catch (error) {
		return await rejectAcquisition(filePath, receipt, error);
	}
}
async function acquireSessionTurn(recordId, signal) {
	return await acquireSessionOwnership(sessionEventLockPath(recordId), signal);
}
async function acquireSessionScope(scope, signal) {
	return await acquireSessionTurn(`ensure:${createHash("sha256").update(JSON.stringify([
		canonicalAgentCommand(scope.agentCommand),
		scope.cwd,
		scope.name
	])).digest("hex")}`, signal);
}
async function acquireSessionImport(signal) {
	return await acquireSessionOwnership(path.join(sessionBaseDir(), ".import-admission.lock"), signal);
}
async function acquireSessionOwnership(requestedPath, signal) {
	await fs$1.mkdir(path.dirname(requestedPath), {
		recursive: true,
		mode: 448
	});
	const filePath = path.join(await fs$1.realpath(path.dirname(requestedPath)), path.basename(requestedPath));
	const owner = await createLockOwner({ signal });
	lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1);
	const payload = `${JSON.stringify({
		...owner.payload,
		created_at: new Date(lastCreatedAt).toISOString()
	}, null, 2)}\n`;
	for (;;) {
		signal?.throwIfAborted();
		const turn = await tryAcquireTurn(filePath, payload, owner, signal);
		if (turn) return turn;
		await setTimeout$1(LOCK_RETRY_MS, void 0, { signal });
	}
}
// src/session/execution/contracts.ts
const DEFAULT_QUEUE_OWNER_TTL_MS = 3e5;
function normalizeQueueOwnerTtlMs(ttlMs) {
	if (ttlMs == null) return DEFAULT_QUEUE_OWNER_TTL_MS;
	if (!Number.isFinite(ttlMs) || ttlMs < 0) return DEFAULT_QUEUE_OWNER_TTL_MS;
	return Math.round(ttlMs);
}
// src/file-read-window.ts
function sliceReadWindow(content, line, limit) {
	if (line == null && limit == null) return content;
	const lines = content.split("\n");
	const startIndex = Math.max(0, (line == null ? 1 : Math.max(1, Math.trunc(line))) - 1);
	const maxLines = limit == null ? void 0 : Math.max(0, Math.trunc(limit));
	if (maxLines === 0) return "";
	const endIndex = maxLines == null ? lines.length : Math.min(lines.length, startIndex + maxLines);
	return lines.slice(startIndex, endIndex).join("\n");
}
// src/permission-prompt.ts
function visiblePromptText(value) {
	let rendered = "";
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== void 0 && (codePoint <= 31 || codePoint >= 127 && codePoint <= 159)) {
			rendered += `\\x${codePoint.toString(16).padStart(2, "0")}`;
			continue;
		}
		rendered += character;
	}
	return rendered;
}
let promptQueue = Promise.resolve();
async function promptForPermission(options) {
	options.signal?.throwIfAborted();
	const result = promptQueue.then(() => askPermission(options));
	promptQueue = result.then(() => {}, () => {});
	const signal = options.signal;
	if (!signal) return await result;
	let onAbort = () => {};
	const aborted = new Promise((_, reject) => {
		onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([result, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
function promptForDisplay(prompt) {
	if (prompt.startsWith("\n")) return `\n${visiblePromptText(prompt.slice(1))}`;
	return visiblePromptText(prompt);
}
async function askPermission(options) {
	options.signal?.throwIfAborted();
	if (!canPrompt()) return false;
	writePromptDetails(options);
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stderr
	});
	const questionController = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, questionController.signal]) : questionController.signal;
	let onClose = () => {};
	const closed = new Promise((resolve) => {
		onClose = () => resolve(void 0);
		rl.once("close", onClose);
	});
	try {
		const answer = await Promise.race([rl.question(promptForDisplay(options.prompt), { signal }), closed]);
		options.signal?.throwIfAborted();
		const normalized = answer?.trim().toLowerCase();
		return normalized === "y" || normalized === "yes";
	} finally {
		rl.removeListener("close", onClose);
		questionController.abort();
		rl.close();
	}
}
function canPrompt() {
	return process.stdin.isTTY && process.stderr.isTTY && !process.stdin.readableEnded && !process.stdin.destroyed;
}
function writePromptDetails(options) {
	if (options.header) process.stderr.write(`\n${visiblePromptText(options.header)}\n`);
	if (options.details && options.details.trim().length > 0) process.stderr.write(`${options.details.split("\n").map(visiblePromptText).join("\n")}\n`);
}
// src/filesystem.ts
const WRITE_PREVIEW_MAX_LINES = 16;
const WRITE_PREVIEW_MAX_CHARS = 1200;
function nowIso$1() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
function toWritePreview(content) {
	const lines = content.replace(/\r\n/g, "\n").split("\n");
	const visibleLines = lines.slice(0, WRITE_PREVIEW_MAX_LINES);
	let preview = visibleLines.join("\n");
	if (lines.length > visibleLines.length) preview += `\n... (${lines.length - visibleLines.length} more lines)`;
	if (preview.length > WRITE_PREVIEW_MAX_CHARS) preview = `${preview.slice(0, 1197)}...`;
	return preview;
}
async function defaultConfirmWrite(filePath, preview, signal) {
	return await promptForPermission({
		header: `[permission] Allow write to ${filePath}?`,
		details: preview,
		prompt: "Allow write? (y/N) ",
		signal
	});
}
function canPromptForPermission$2() {
	return process.stdin.isTTY && process.stderr.isTTY;
}
var FileSystemHandlers = class {
	rootDir;
	workspace;
	permissionMode;
	nonInteractivePermissions;
	onOperation;
	usesDefaultConfirmWrite;
	confirmWrite;
	constructor(options) {
		this.rootDir = path.resolve(options.cwd);
		this.permissionMode = options.permissionMode;
		this.nonInteractivePermissions = options.nonInteractivePermissions ?? "deny";
		this.onOperation = options.onOperation;
		this.usesDefaultConfirmWrite = options.confirmWrite == null;
		this.confirmWrite = options.confirmWrite ?? defaultConfirmWrite;
	}
	updatePermissionPolicy(permissionMode, nonInteractivePermissions) {
		this.permissionMode = permissionMode;
		this.nonInteractivePermissions = nonInteractivePermissions ?? "deny";
	}
	async readTextFile(params, authority) {
		assertControlAuthority(authority);
		const filePath = this.resolvePathWithinRoot(params.path);
		const summary = `read_text_file: ${filePath}`;
		this.emitOperation({
			method: "fs/read_text_file",
			status: "running",
			summary,
			details: this.readWindowDetails(params.line, params.limit),
			timestamp: nowIso$1()
		});
		try {
			if (this.permissionMode === "deny-all") throw new PermissionDeniedError("Permission denied for fs/read_text_file (--deny-all)");
			const content = await (await this.getWorkspace()).readText(filePath);
			assertControlAuthority(authority);
			const sliced = sliceReadWindow(content, params.line, params.limit);
			this.emitOperation({
				method: "fs/read_text_file",
				status: "completed",
				summary,
				details: this.readWindowDetails(params.line, params.limit),
				timestamp: nowIso$1()
			});
			return { content: sliced };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.emitOperation({
				method: "fs/read_text_file",
				status: "failed",
				summary,
				details: message,
				timestamp: nowIso$1()
			});
			throw error;
		}
	}
	async writeTextFile(params, authority) {
		assertControlAuthority(authority);
		const filePath = this.resolvePathWithinRoot(params.path);
		const preview = toWritePreview(params.content);
		const summary = `write_text_file: ${filePath}`;
		this.emitOperation({
			method: "fs/write_text_file",
			status: "running",
			summary,
			details: preview,
			timestamp: nowIso$1()
		});
		try {
			const approved = await this.isWriteApproved(filePath, preview, authority?.signal);
			assertControlAuthority(authority);
			if (!approved) throw new PermissionDeniedError("Permission denied for fs/write_text_file");
			const workspace = await this.getWorkspace();
			const target = await workspace.resolve(filePath);
			const file = await workspace.openWritable(target, {
				mode: 438,
				assertBeforeMutation: () => assertControlAuthority(authority)
			});
			try {
				assertControlAuthority(authority);
				await file.handle.writeFile(params.content, "utf8");
			} finally {
				await file.handle.close();
			}
			this.emitOperation({
				method: "fs/write_text_file",
				status: "completed",
				summary,
				details: preview,
				timestamp: nowIso$1()
			});
			return {};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.emitOperation({
				method: "fs/write_text_file",
				status: "failed",
				summary,
				details: message,
				timestamp: nowIso$1()
			});
			throw error;
		}
	}
	async isWriteApproved(filePath, preview, signal) {
		if (this.permissionMode === "approve-all") return true;
		if (this.permissionMode === "deny-all") return false;
		if (this.usesDefaultConfirmWrite && this.nonInteractivePermissions === "fail" && !canPromptForPermission$2()) throw new PermissionPromptUnavailableError();
		return await this.confirmWrite(filePath, preview, signal);
	}
	resolvePathWithinRoot(rawPath) {
		if (!path.isAbsolute(rawPath)) throw new Error(`Path must be absolute: ${rawPath}`);
		const resolved = path.resolve(rawPath);
		if (!isPathInside(this.rootDir, resolved)) throw new Error(`Path is outside allowed cwd subtree: ${resolved}`);
		return rawPath;
	}
	getWorkspace() {
		return this.workspace ??= root(this.rootDir, {
			symlinks: "follow-within-root",
			hardlinks: "allow",
			maxBytes: Infinity
		});
	}
	readWindowDetails(line, limit) {
		if (line == null && limit == null) return;
		return `line=${line == null ? 1 : Math.max(1, Math.trunc(line))}, limit=${limit == null ? "all" : Math.max(0, Math.trunc(limit))}`;
	}
	emitOperation(operation) {
		this.onOperation?.(operation);
	}
};
// src/permissions.ts
const PERMISSION_MODE_RANK = {
	"deny-all": 0,
	"approve-reads": 1,
	"approve-all": 2
};
function selected(optionId) {
	return { outcome: {
		outcome: "selected",
		optionId
	} };
}
function cancelled() {
	return { outcome: { outcome: "cancelled" } };
}
function withPermissionMetadata(response, metadata) {
	return {
		...response,
		_meta: {
			...response._meta,
			acpx: {
				...response._meta?.acpx && typeof response._meta.acpx === "object" && !Array.isArray(response._meta.acpx) ? response._meta.acpx : {},
				...metadata
			}
		}
	};
}
function pickOption(options, kinds) {
	for (const kind of kinds) {
		const match = options.find((option) => option.kind === kind);
		if (match) return match;
	}
}
const TOOL_KIND_TITLE_MATCHERS = [
	{
		kind: "read",
		names: ["read", "cat"]
	},
	{
		kind: "search",
		names: [
			"search",
			"find",
			"grep"
		]
	},
	{
		kind: "edit",
		names: [
			"write",
			"edit",
			"patch"
		]
	},
	{
		kind: "delete",
		names: ["delete", "remove"]
	},
	{
		kind: "move",
		names: ["move", "rename"]
	},
	{
		kind: "execute",
		names: [
			"run",
			"execute",
			"bash"
		]
	},
	{
		kind: "fetch",
		names: [
			"fetch",
			"http",
			"url"
		]
	},
	{
		kind: "think",
		names: ["think"]
	}
];
function inferToolKind(params) {
	if (params.toolCall.kind) return params.toolCall.kind;
	const title = params.toolCall.title?.trim().toLowerCase();
	if (!title) return;
	const head = title.split(/[:\s]/, 1)[0];
	if (!head) return;
	return TOOL_KIND_TITLE_MATCHERS.find(({ names }) => names.includes(head))?.kind ?? "other";
}
function isAutoApprovedReadKind(kind) {
	return kind === "read" || kind === "search";
}
async function promptForToolPermission(params, signal) {
	return await promptForPermission({
		prompt: `\n[permission] Allow ${params.toolCall.title ?? "tool"} [${inferToolKind(params) ?? "other"}]? (y/N) `,
		signal
	});
}
function canPromptForPermission$1() {
	return process.stdin.isTTY && process.stderr.isTTY;
}
function readStringProperty(value, keys) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const record = value;
	for (const key of keys) {
		const entry = record[key];
		if (typeof entry === "string" && entry.trim().length > 0) return entry.trim();
	}
}
function readToolName(params) {
	const rawInputName = readStringProperty(params.toolCall.rawInput, [
		"name",
		"tool",
		"toolName"
	]);
	if (rawInputName) return rawInputName;
	const head = (params.toolCall.title?.trim())?.split(/[:\s]/, 1)[0]?.trim();
	return head && head.length > 0 ? head : void 0;
}
function normalizeMatcher(value) {
	return value.trim().toLowerCase();
}
function permissionMatchTokens(params) {
	const tokens = /* @__PURE__ */ new Set();
	const kind = inferToolKind(params);
	const rawKind = params.toolCall.kind;
	const title = params.toolCall.title?.trim();
	const toolName = readToolName(params);
	for (const value of [
		kind,
		rawKind,
		title,
		toolName
	]) if (typeof value === "string" && value.trim().length > 0) tokens.add(normalizeMatcher(value));
	if (title) {
		const head = title.split(/[:\s]/, 1)[0]?.trim();
		if (head) tokens.add(normalizeMatcher(head));
	}
	return [...tokens];
}
function findPolicyRule(rules, params) {
	if (!rules || rules.length === 0) return;
	const tokens = permissionMatchTokens(params);
	for (const rule of rules) {
		const normalized = normalizeMatcher(rule);
		if (normalized === "*" || tokens.includes(normalized)) return rule;
	}
}
function matchPermissionPolicy(params, policy) {
	if (!policy) return;
	const denyRule = findPolicyRule(policy.autoDeny, params);
	if (denyRule) return {
		action: "deny",
		matchedRule: denyRule
	};
	const approveRule = findPolicyRule(policy.autoApprove, params);
	if (approveRule) return {
		action: "approve",
		matchedRule: approveRule
	};
	const escalateRule = findPolicyRule(policy.escalate, params);
	if (escalateRule) return {
		action: "escalate",
		matchedRule: escalateRule
	};
	return policy.defaultAction ? { action: policy.defaultAction } : void 0;
}
function buildEscalationEvent(params, matchedRule) {
	const toolKind = inferToolKind(params);
	const toolTitle = params.toolCall.title?.trim() || "tool";
	const toolName = readToolName(params);
	return {
		type: "permission_escalation",
		sessionId: params.sessionId,
		toolCallId: params.toolCall.toolCallId,
		...toolName ? { toolName } : {},
		toolTitle,
		...params.toolCall.rawInput !== void 0 ? { toolInput: params.toolCall.rawInput } : {},
		...toolKind ? { toolKind } : {},
		action: "escalate",
		...matchedRule ? { matchedRule } : {},
		message: `Permission escalation required for ${toolTitle}`,
		timestamp: (/* @__PURE__ */ new Date()).toISOString()
	};
}
function selectedOrFirst(options, allowOption) {
	return { response: selected((allowOption ?? options[0]).optionId) };
}
function selectedOrCancelled(option) {
	return { response: option ? selected(option.optionId) : cancelled() };
}
async function resolveEscalatingPermissionRequest(params, policyMatch, allowOption, rejectOption, signal) {
	if (canPromptForPermission$1()) return resolveInteractivePromptResult(params, allowOption, rejectOption, signal);
	const escalation = buildEscalationEvent(params, policyMatch.matchedRule);
	return {
		response: withPermissionMetadata(rejectOption ? selected(rejectOption.optionId) : cancelled(), { permissionEscalation: escalation }),
		escalation
	};
}
async function resolveInteractivePromptResult(params, allowOption, rejectOption, signal) {
	const approved = await promptForToolPermission(params, signal);
	if (approved && allowOption) return { response: selected(allowOption.optionId) };
	if (!approved && rejectOption) return { response: selected(rejectOption.optionId) };
	return { response: cancelled() };
}
function resolvePolicyMatch(params, policyMatch, options, allowOption, rejectOption, signal) {
	if (policyMatch?.action === "approve") return selectedOrFirst(options, allowOption);
	if (policyMatch?.action === "deny") return selectedOrCancelled(rejectOption);
	if (policyMatch?.action === "escalate") return resolveEscalatingPermissionRequest(params, policyMatch, allowOption, rejectOption, signal);
}
function resolveModeMatch(options, mode, allowOption, rejectOption) {
	if (mode === "approve-all") return selectedOrFirst(options, allowOption);
	if (mode === "deny-all") return selectedOrCancelled(rejectOption);
}
function resolveNonInteractivePermission(nonInteractivePolicy, rejectOption) {
	if (nonInteractivePolicy === "fail") throw new PermissionPromptUnavailableError();
	return selectedOrCancelled(rejectOption);
}
async function resolveReadOrPromptPermission(params, nonInteractivePolicy, allowOption, rejectOption, signal) {
	if (isAutoApprovedReadKind(inferToolKind(params)) && allowOption) return { response: selected(allowOption.optionId) };
	if (!canPromptForPermission$1()) return resolveNonInteractivePermission(nonInteractivePolicy, rejectOption);
	return resolveInteractivePromptResult(params, allowOption, rejectOption, signal);
}
function permissionModeSatisfies(actual, required) {
	return PERMISSION_MODE_RANK[actual] >= PERMISSION_MODE_RANK[required];
}
async function resolvePermissionRequestWithDetails(params, mode, nonInteractivePolicy = "deny", policy, signal) {
	try {
		signal?.throwIfAborted();
		const result = await resolvePermissionByPolicy(params, mode, nonInteractivePolicy, policy, signal);
		signal?.throwIfAborted();
		return result;
	} catch (error) {
		if (signal?.aborted) return { response: cancelled() };
		throw error;
	}
}
async function resolvePermissionByPolicy(params, mode, nonInteractivePolicy, policy, signal) {
	const options = params.options ?? [];
	if (options.length === 0) return { response: cancelled() };
	const allowOption = pickOption(options, ["allow_once", "allow_always"]);
	const rejectOption = pickOption(options, ["reject_once", "reject_always"]);
	const resolvedByPolicy = await resolvePolicyMatch(params, matchPermissionPolicy(params, policy), options, allowOption, rejectOption, signal);
	if (resolvedByPolicy) return resolvedByPolicy;
	const resolvedByMode = resolveModeMatch(options, mode, allowOption, rejectOption);
	if (resolvedByMode) return resolvedByMode;
	return resolveReadOrPromptPermission(params, nonInteractivePolicy, allowOption, rejectOption, signal);
}
const DECISION_FALLBACK_ORDER = {
	allow_once: ["allow_once", "allow_always"],
	allow_always: ["allow_always", "allow_once"],
	reject_once: ["reject_once", "reject_always"],
	reject_always: ["reject_always", "reject_once"]
};
function decisionToResponse(params, decision) {
	if (decision.outcome === "cancel") return cancelled();
	if (decision.outcome === "selected") return params.options.some((option) => option.optionId === decision.optionId) ? selected(decision.optionId) : cancelled();
	const matched = pickOption(params.options ?? [], DECISION_FALLBACK_ORDER[decision.outcome]);
	return matched ? selected(matched.optionId) : cancelled();
}
function classifyPermissionDecision(params, response) {
	if (response.outcome.outcome !== "selected") return "cancelled";
	const selectedOptionId = response.outcome.optionId;
	const selectedOption = params.options.find((option) => option.optionId === selectedOptionId);
	if (!selectedOption) return "cancelled";
	if (selectedOption.kind === "allow_once" || selectedOption.kind === "allow_always") return "approved";
	return "denied";
}
// src/acp/agent-command.ts
const DEFAULT_AGENT_CLOSE_AFTER_STDIN_END_MS = 100;
const QODER_AGENT_CLOSE_AFTER_STDIN_END_MS = 750;
const GEMINI_ACP_STARTUP_TIMEOUT_MS = 15e3;
const CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS = 6e4;
const GEMINI_VERSION_TIMEOUT_MS = 2e3;
const GEMINI_ACP_FLAG_VERSION = [
	0,
	33,
	0
];
const COPILOT_HELP_TIMEOUT_MS = 2e3;
const CLAUDE_CODE_DEFAULT_SETTING_SOURCES = ["project", "local"];
const QODER_BENIGN_STDOUT_LINES = /* @__PURE__ */ new Set(["Received interrupt signal. Cleaning up resources...", "Cleanup completed. Exiting..."]);
function resolveAgentCloseAfterStdinEndMs(agentCommand) {
	const { command } = splitCommandLine(agentCommand);
	return basenameToken(command) === "qodercli" ? QODER_AGENT_CLOSE_AFTER_STDIN_END_MS : DEFAULT_AGENT_CLOSE_AFTER_STDIN_END_MS;
}
function shouldIgnoreNonJsonAgentOutputLine(agentCommand, trimmedLine) {
	const { command } = splitCommandLine(agentCommand);
	return basenameToken(command) === "qodercli" && QODER_BENIGN_STDOUT_LINES.has(trimmedLine);
}
function isGeminiAcpCommand(command, args) {
	return basenameToken(command) === "gemini" && (args.includes("--acp") || args.includes("--experimental-acp"));
}
function isClaudeAcpCommand(command, args) {
	if (basenameToken(command) === "claude-agent-acp") return true;
	return args.some((arg) => arg.includes("claude-agent-acp"));
}
function isCopilotAcpCommand(command, args) {
	return basenameToken(command) === "copilot" && args.includes("--acp");
}
function isQoderAcpCommand(command, args) {
	return basenameToken(command) === "qodercli" && args.includes("--acp");
}
function isCursorAcpCommand(command, args) {
	const commandToken = basenameToken(command);
	return commandToken === "cursor-agent" || commandToken === "agent" && args.includes("acp");
}
function isDevinAcpCommand(command, args) {
	return basenameToken(command) === "devin" && (args.includes("acp") || args.includes("--acp") || args.includes("--experimental-acp"));
}
function hasCommandFlag(args, flagName) {
	return args.some((arg) => arg === flagName || arg.startsWith(`${flagName}=`));
}
function normalizeQoderAllowedToolName(tool) {
	switch (tool.trim().toLowerCase()) {
		case "bash":
		case "glob":
		case "grep":
		case "ls":
		case "read":
		case "write": return tool.trim().toUpperCase();
		default: return tool.trim();
	}
}
function buildQoderAcpCommandArgs(initialArgs, options) {
	const args = [...initialArgs];
	const sessionOptions = options.sessionOptions;
	if (typeof sessionOptions?.maxTurns === "number" && !hasCommandFlag(args, "--max-turns")) args.push(`--max-turns=${sessionOptions.maxTurns}`);
	if (Array.isArray(sessionOptions?.allowedTools) && !hasCommandFlag(args, "--allowed-tools") && !hasCommandFlag(args, "--disallowed-tools")) {
		const encodedTools = sessionOptions.allowedTools.map(normalizeQoderAllowedToolName).join(",");
		args.push(`--allowed-tools=${encodedTools}`);
	}
	return args;
}
function resolveGeminiAcpStartupTimeoutMs() {
	const raw = process.env.ACPX_GEMINI_ACP_STARTUP_TIMEOUT_MS;
	if (typeof raw === "string" && raw.trim().length > 0) {
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
	}
	return GEMINI_ACP_STARTUP_TIMEOUT_MS;
}
function resolveClaudeAcpSessionCreateTimeoutMs() {
	const raw = process.env.ACPX_CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS;
	if (typeof raw === "string" && raw.trim().length > 0) {
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
	}
	return CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS;
}
function parseGeminiVersion(value) {
	if (typeof value !== "string") return;
	const normalized = value.trim();
	const match = normalized.match(/(\d+)\.(\d+)\.(\d+)/);
	if (!match) return;
	return {
		raw: normalized,
		parts: [
			Number(match[1]),
			Number(match[2]),
			Number(match[3])
		]
	};
}
function compareVersionParts(left, right) {
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const leftPart = left[index] ?? 0;
		const rightPart = right[index] ?? 0;
		if (leftPart !== rightPart) return leftPart - rightPart;
	}
	return 0;
}
async function detectGeminiVersion(command, context, diagnostic = false) {
	const versionLine = (await context.readOutput(command, ["--version"], GEMINI_VERSION_TIMEOUT_MS, diagnostic))?.split(/\r?\n/).map((line) => line.trim()).find((line) => /\d+\.\d+\.\d+/.test(line));
	return parseGeminiVersion(versionLine);
}
async function resolveGeminiCommandArgs(command, args, context) {
	if (basenameToken(command) !== "gemini" || !args.includes("--acp")) return [...args];
	const version = await detectGeminiVersion(command, context);
	if (version && compareVersionParts(version.parts, GEMINI_ACP_FLAG_VERSION) < 0) return args.map((arg) => arg === "--acp" ? "--experimental-acp" : arg);
	return [...args];
}
async function buildGeminiAcpStartupTimeoutMessage(command, context) {
	const parts = ["Gemini CLI ACP startup timed out before initialize completed.", "This usually means the local Gemini CLI is waiting on interactive OAuth or has incompatible ACP subprocess behavior."];
	const version = await detectGeminiVersion(command, context, true);
	if (version) parts.push(`Detected Gemini CLI version: ${version.raw}.`);
	const env = context.env;
	if (!env.GEMINI_API_KEY && !env.GOOGLE_API_KEY) parts.push("No GEMINI_API_KEY or GOOGLE_API_KEY was set for non-interactive auth.");
	parts.push("Try upgrading Gemini CLI and using API-key-based auth for non-interactive ACP runs.");
	return parts.join(" ");
}
function buildClaudeAcpSessionCreateTimeoutMessage() {
	return [
		"Claude ACP session creation timed out before session/new completed.",
		"This matches the known persistent-session stall seen with some Claude Code and @agentclientprotocol/claude-agent-acp combinations.",
		"In harnessed or non-interactive runs, prefer --approve-all with nonInteractivePermissions=deny, upgrade Claude Code and the Claude ACP adapter, or use acpx claude exec as a one-shot fallback."
	].join(" ");
}
function buildCopilotAcpUnsupportedMessage() {
	return [
		"GitHub Copilot CLI ACP stdio mode is not available in the installed copilot binary.",
		"acpx copilot expects a Copilot CLI release that supports --acp --stdio.",
		"Detected copilot --help output without --acp support.",
		"Upgrade GitHub Copilot CLI to a release with ACP stdio support, or use --agent with another ACP-compatible adapter in the meantime."
	].join(" ");
}
async function ensureCopilotAcpSupport(command, context) {
	const helpOutput = await context.readOutput(command, ["--help"], COPILOT_HELP_TIMEOUT_MS);
	if (typeof helpOutput === "string" && !helpOutput.includes("--acp")) throw new CopilotAcpUnsupportedError(buildCopilotAcpUnsupportedMessage(), { retryable: false });
}
function buildClaudeCodeOptionsMeta(options, isolateUserSettings = false) {
	const claudeCodeOptions = {};
	if (isolateUserSettings) claudeCodeOptions.settingSources = resolveClaudeCodeSettingSources();
	if (options) assignClaudeCodeOptions(claudeCodeOptions, options);
	const meta = {};
	if (Object.keys(claudeCodeOptions).length > 0) meta.claudeCode = { options: claudeCodeOptions };
	assignClaudeCodeSystemPrompt(meta, options?.systemPrompt);
	if (Object.keys(meta).length === 0) return;
	return meta;
}
function resolveClaudeCodeSettingSources(env = process.env) {
	if (env.ACPX_CLAUDE_INCLUDE_USER_SETTINGS?.trim() === "1") return ["user", ...CLAUDE_CODE_DEFAULT_SETTING_SOURCES];
	return [...CLAUDE_CODE_DEFAULT_SETTING_SOURCES];
}
function assignClaudeCodeOptions(target, options) {
	if (typeof options.model === "string" && options.model.trim().length > 0) target.model = options.model;
	if (Array.isArray(options.allowedTools)) target.allowedTools = [...options.allowedTools];
	if (typeof options.maxTurns === "number") target.maxTurns = options.maxTurns;
}
function assignClaudeCodeSystemPrompt(target, systemPrompt) {
	if (typeof systemPrompt === "string" && systemPrompt.length > 0) {
		target.systemPrompt = systemPrompt;
		return;
	}
	if (isAppendSystemPrompt(systemPrompt)) target.systemPrompt = { append: systemPrompt.append };
}
function isAppendSystemPrompt(value) {
	return !!value && typeof value === "object" && typeof value.append === "string" && value.append.length > 0;
}
function resolveClaudeCodeExecutable(platform = process.platform, env = process.env, cwd) {
	if (platform !== "win32") return;
	if (readWindowsEnvValue(env, "CLAUDE_CODE_EXECUTABLE")) return;
	return resolveWindowsExecutablePath("claude", env, cwd);
}
// src/acp/inherited-env.ts
const AUTH_GRANT_PREFIX = "ACPX_AUTH_";
const POSIX_ESSENTIAL_NAMES = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LANGUAGE",
	"TZ",
	"TMPDIR",
	"TMP",
	"TEMP"
];
const WINDOWS_ESSENTIAL_NAMES = [
	"SYSTEMROOT",
	"WINDIR",
	"SYSTEMDRIVE",
	"COMSPEC",
	"PATHEXT",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"USERNAME",
	"USERDOMAIN",
	"APPDATA",
	"LOCALAPPDATA",
	"PROGRAMDATA",
	"ALLUSERSPROFILE",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PROGRAMW6432",
	"COMMONPROGRAMFILES",
	"COMMONPROGRAMFILES(X86)",
	"COMMONPROGRAMW6432"
];
const ESSENTIAL_PREFIXES = ["LC_", "XDG_"];
/** Environment name as compared on this platform: Windows names are case-insensitive. */
function envNameKey(name) {
	return process.platform === "win32" ? name.toUpperCase() : name;
}
function essentialNames() {
	return process.platform === "win32" ? [...POSIX_ESSENTIAL_NAMES, ...WINDOWS_ESSENTIAL_NAMES] : POSIX_ESSENTIAL_NAMES;
}
function isEnvName(name) {
	return typeof name === "string" && name.length > 0 && !name.includes("=") && !name.includes("\0");
}
function validateEnvNames(option, names) {
	if (!Array.isArray(names) || !names.every(isEnvName)) throw new Error(`Invalid ${option}: expected an array of non-empty names without NUL or '='`);
	return names;
}
/** Validate and copy an embedder's name list once, when a client or runtime is constructed. */
function snapshotEnvNames(option, names) {
	return names === void 0 ? void 0 : [...validateEnvNames(option, names)];
}
function inheritedNameFilter(policy) {
	const blocked = new Set((policy?.block ?? []).map(envNameKey));
	const allowed = policy?.allow ? new Set([...essentialNames(), ...policy.allow].map(envNameKey)) : void 0;
	return (name) => {
		const key = envNameKey(name);
		if (key.startsWith(AUTH_GRANT_PREFIX)) return true;
		if (blocked.has(key)) return false;
		return !allowed || allowed.has(key) || ESSENTIAL_PREFIXES.some((p) => key.startsWith(p));
	};
}
/** Whether a parent environment name reaches agent children under this policy. */
function isInheritedEnvName(policy, name) {
	return inheritedNameFilter(policy)(name);
}
/** Whether the policy changes inheritance at all; with neither list set it does not. */
function hasInheritedEnvPolicy(policy) {
	return policy?.allow !== void 0 || (policy?.block?.length ?? 0) > 0;
}
/** Copy the parent environment, keeping only the names this policy lets children inherit. */
function inheritParentEnvironment(policy) {
	const env = { ...process.env };
	if (!hasInheritedEnvPolicy(policy)) return env;
	validateEnvNames("agentProcessEnvAllow", policy?.allow ?? []);
	validateEnvNames("agentProcessEnvBlock", policy?.block ?? []);
	const inherits = inheritedNameFilter(policy);
	for (const name of Object.keys(env)) if (!inherits(name)) delete env[name];
	return env;
}
// src/acp/auth-env.ts
const AUTH_ENV_PREFIX = "ACPX_AUTH_";
function toEnvToken(value) {
	return value.trim().replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}
function buildAuthEnvKey(methodId) {
	const token = toEnvToken(methodId);
	return token.length > 0 ? `${AUTH_ENV_PREFIX}${token}` : void 0;
}
const authEnvKeyCache = /* @__PURE__ */ new Map();
function authEnvKey(methodId) {
	const cached = authEnvKeyCache.get(methodId);
	if (cached !== void 0) return cached;
	const key = buildAuthEnvKey(methodId);
	authEnvKeyCache.set(methodId, key);
	return key;
}
function readEnvCredential(methodId) {
	const key = authEnvKey(methodId);
	if (!key) return;
	const value = process.env[key];
	if (typeof value === "string" && value.trim().length > 0) return value;
}
function protectedEnvKey(key) {
	return process.platform === "win32" ? key.toUpperCase() : key;
}
function isAuthEnvKey(key) {
	return protectedEnvKey(key).startsWith(AUTH_ENV_PREFIX);
}
function authEnvSuffix(key) {
	return key.slice(10);
}
function protectEnvKey(protectedKeys, key) {
	protectedKeys.add(protectedEnvKey(key));
}
function promotePrefixedAuthEnvironment(env) {
	const protectedKeys = /* @__PURE__ */ new Set();
	for (const [key, value] of Object.entries(env)) {
		if (!isAuthEnvKey(key)) continue;
		if (typeof value !== "string" || value.trim().length === 0) continue;
		const normalized = toEnvToken(authEnvSuffix(key));
		if (!normalized) continue;
		protectEnvKey(protectedKeys, key);
		protectEnvKey(protectedKeys, normalized);
		assignIfMissing(env, normalized, value);
	}
	return protectedKeys;
}
function validateAgentProcessEnv(agentProcessEnv) {
	for (const [key, value] of Object.entries(agentProcessEnv ?? {})) if (typeof value !== "string" || key.includes("=") || key.includes("\0") || value.includes("\0")) throw new Error("Invalid agentProcessEnv: environment entries cannot contain NUL or names with '='");
}
function buildAgentEnvironment(authCredentials, sessionEnv, agentProcessEnv, inheritedEnv) {
	validateAgentProcessEnv(agentProcessEnv);
	const env = inheritParentEnvironment(inheritedEnv);
	const protectedAuthEnvKeys = promotePrefixedAuthEnvironment(env);
	if (authCredentials) for (const [methodId, credential] of Object.entries(authCredentials)) {
		addAuthCredentialEnvKeys(protectedAuthEnvKeys, methodId, credential);
		assignAuthCredentialEnv(env, methodId, credential);
	}
	for (const overlay of [sessionEnv, agentProcessEnv]) for (const [key, value] of Object.entries(overlay ?? {})) {
		if (typeof value !== "string" || protectedAuthEnvKeys.has(protectedEnvKey(key))) continue;
		assignSessionEnv(env, key, value);
	}
	return env;
}
function assignSessionEnv(env, key, value) {
	const normalizedKey = protectedEnvKey(key);
	for (const existingKey of Object.keys(env)) if (protectedEnvKey(existingKey) === normalizedKey) delete env[existingKey];
	Object.defineProperty(env, key, {
		value,
		writable: true,
		enumerable: true,
		configurable: true
	});
}
function addAuthCredentialEnvKeys(protectedKeys, methodId, credential) {
	if (typeof credential !== "string" || credential.trim().length === 0) return;
	if (!methodId.includes("=") && !methodId.includes("\0")) protectEnvKey(protectedKeys, methodId);
	const normalized = toEnvToken(methodId);
	if (normalized) {
		protectEnvKey(protectedKeys, `${AUTH_ENV_PREFIX}${normalized}`);
		protectEnvKey(protectedKeys, normalized);
	}
}
function assignAuthCredentialEnv(env, methodId, credential) {
	if (typeof credential !== "string" || credential.trim().length === 0) return;
	if (!methodId.includes("=") && !methodId.includes("\0")) assignIfMissing(env, methodId, credential);
	const normalized = toEnvToken(methodId);
	if (normalized) {
		assignIfMissing(env, `${AUTH_ENV_PREFIX}${normalized}`, credential);
		assignIfMissing(env, normalized, credential);
	}
}
function assignIfMissing(env, key, value) {
	if (env[key] != null) return;
	const normalizedKey = protectedEnvKey(key);
	if (process.platform === "win32" && Object.entries(env).some(([existingKey, existingValue]) => existingValue != null && protectedEnvKey(existingKey) === normalizedKey)) return;
	env[key] = value;
}
function resolveConfiguredAuthCredential(methodId, authCredentials) {
	const configCredentials = authCredentials ?? {};
	return configCredentials[methodId] ?? configCredentials[toEnvToken(methodId)];
}
function buildAgentSpawnOptions(cwd, authCredentials, sessionEnv, agentProcessEnv, inheritedEnv) {
	return {
		cwd,
		env: buildAgentEnvironment(authCredentials, sessionEnv, agentProcessEnv, inheritedEnv),
		stdio: [
			"pipe",
			"pipe",
			"pipe"
		],
		windowsHide: true
	};
}
// src/version.ts
const UNKNOWN_VERSION = "0.0.0-unknown";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
let cachedVersion = null;
function parseVersion(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}
function readPackageVersion(packageJsonPath) {
	try {
		return parseVersion(JSON.parse(readFileSync(packageJsonPath, "utf8")).version);
	} catch {
		return null;
	}
}
function resolveVersionFromAncestors(startDir) {
	let current = startDir;
	while (true) {
		const packageVersion = readPackageVersion(path.join(current, "package.json"));
		if (packageVersion) return packageVersion;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}
function resolveAcpxVersion(params) {
	const envVersion = resolvePackageEnvVersion(params?.env ?? process.env);
	if (envVersion) return envVersion;
	if (params?.packageJsonPath) return readPackageVersion(params.packageJsonPath) ?? UNKNOWN_VERSION;
	return resolveVersionFromAncestors(MODULE_DIR) ?? UNKNOWN_VERSION;
}
function resolvePackageEnvVersion(env) {
	const envPackageName = parseVersion(env.npm_package_name);
	const envVersion = parseVersion(env.npm_package_version);
	return envPackageName === "acpx" ? envVersion : null;
}
function getAcpxVersion() {
	if (cachedVersion) return cachedVersion;
	cachedVersion = resolveAcpxVersion();
	return cachedVersion;
}
// src/acp/client-protocol.ts
const DEVIN_COMPATIBILITY_CLIENT_CAPABILITIES_META = Object.freeze({ "cognition.ai/requestDiagnostics": true });
const DEVIN_COMPATIBILITY_CLIENT_NAME = "windsurf";
const DEFAULT_DEVIN_COMPATIBILITY_CLIENT_VERSION = "1.110.1";
function resolveClientInfo(devinAcp) {
	if (!devinAcp) return {
		name: "acpx",
		version: getAcpxVersion()
	};
	return {
		name: DEVIN_COMPATIBILITY_CLIENT_NAME,
		version: process.env.ACPX_DEVIN_WINDSURF_VERSION ?? DEFAULT_DEVIN_COMPATIBILITY_CLIENT_VERSION
	};
}
function resolveClientCapabilities(params) {
	const baseCapabilities = {
		fs: {
			readTextFile: params.fs,
			writeTextFile: params.fs
		},
		terminal: params.terminal,
		...params.elicitationModes.length > 0 ? { elicitation: {
			...params.elicitationModes.includes("form") ? { form: {} } : {},
			...params.elicitationModes.includes("url") ? { url: {} } : {}
		} } : {}
	};
	if (!params.devinAcp) return baseCapabilities;
	return {
		...baseCapabilities,
		_meta: DEVIN_COMPATIBILITY_CLIENT_CAPABILITIES_META
	};
}
// src/acp/command-probe.ts
var CommandProbeAdmissionError = class extends Error {
	reason;
	constructor(reason) {
		super("Agent command admission rejected", { cause: reason });
		this.reason = reason;
		this.name = "CommandProbeAdmissionError";
	}
};
async function admitCommandProbe(admit) {
	try {
		return await admit();
	} catch (error) {
		throw new CommandProbeAdmissionError(error);
	}
}
/** Collect only this short adapter command; its client owns process retirement. */
function captureCommandProbeOutput(child, timeoutMs, retire) {
	let stdout = "";
	let stderr = "";
	let settled = false;
	let disposed = false;
	let timer;
	let resolveResult;
	const result = new Promise((resolve) => {
		resolveResult = resolve;
	});
	const finish = (value) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		resolveResult(value);
	};
	const fail = () => {
		if (disposed) return;
		finish(void 0);
		retire().catch(() => {});
	};
	const onStdout = (chunk) => {
		if (!settled) stdout += chunk;
	};
	const onStderr = (chunk) => {
		if (!settled) stderr += chunk;
	};
	const onClose = () => finish(`${stdout}\n${stderr}`);
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", onStdout);
	child.stderr?.on("data", onStderr);
	child.on("error", fail);
	child.stdout?.on("error", fail);
	child.stderr?.on("error", fail);
	child.once("close", onClose);
	timer = setTimeout(fail, timeoutMs);
	return {
		result,
		dispose: () => {
			disposed = true;
			finish(void 0);
			clearTimeout(timer);
			child.stdout?.off("data", onStdout);
			child.stderr?.off("data", onStderr);
			child.off("close", onClose);
		}
	};
}
// src/acp/model-config-state.ts
function asRecord$2(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value;
}
function parseAvailableModel(value) {
	const option = asRecord$2(value);
	if (!option || typeof option.value !== "string" || typeof option.name !== "string") return;
	return {
		modelId: option.value,
		name: option.name
	};
}
function parseAvailableModelGroup(value) {
	const group = asRecord$2(value);
	if (!group || typeof group.group !== "string" || typeof group.name !== "string" || !Array.isArray(group.options)) return;
	const models = group.options.map((option) => parseAvailableModel(option));
	return models.every((model) => model !== void 0) ? models : void 0;
}
function parseAvailableModels(value) {
	if (!Array.isArray(value)) return;
	const directModels = value.map((option) => parseAvailableModel(option));
	if (directModels.every((model) => model !== void 0)) return directModels;
	const groupedModels = value.map((group) => parseAvailableModelGroup(group));
	return groupedModels.every((models) => models !== void 0) ? groupedModels.flat() : void 0;
}
function isModelSelectOption(option) {
	return option.type === "select" && (option.category === "model" || option.id === "model");
}
function parseModelConfigOption(option) {
	if (!isModelSelectOption(option) || typeof option.id !== "string" || typeof option.currentValue !== "string") return;
	const availableModels = parseAvailableModels(option.options);
	return availableModels ? {
		configId: option.id,
		currentModelId: option.currentValue,
		availableModels
	} : void 0;
}
function modelConfigPriority(option) {
	if (option.category !== "model") return 0;
	return option.id === "model" ? 2 : 1;
}
function modelStateFromConfigOptions(configOptions) {
	if (!Array.isArray(configOptions)) return;
	let selected;
	let selectedPriority = -1;
	for (const value of configOptions) {
		const option = asRecord$2(value);
		if (!option) continue;
		const models = parseModelConfigOption(option);
		if (!models) continue;
		const priority = modelConfigPriority(option);
		if (priority > selectedPriority) {
			selected = models;
			selectedPriority = priority;
		}
	}
	return selected;
}
// src/acp/model-support.ts
const REQUESTED_MODEL_UNSUPPORTED_ERROR_CODE = "ACP_MODEL_UNSUPPORTED";
const REQUESTED_MODEL_UNSUPPORTED_REASONS = ["missing-capability", "unadvertised-model"];
var RequestedModelUnsupportedError = class extends Error {
	code = REQUESTED_MODEL_UNSUPPORTED_ERROR_CODE;
	reason;
	ambiguous;
	constructor(message, reason, details) {
		super(message);
		this.name = "RequestedModelUnsupportedError";
		this.reason = reason;
		if (details?.ambiguous) this.ambiguous = true;
	}
};
function isRequestedModelUnsupportedReason(value) {
	return typeof value === "string" && REQUESTED_MODEL_UNSUPPORTED_REASONS.includes(value);
}
function isRequestedModelUnsupportedError(value) {
	if (value instanceof RequestedModelUnsupportedError) return true;
	if (!value || typeof value !== "object") return false;
	const candidate = value;
	return candidate.name === "RequestedModelUnsupportedError" && candidate.code === "ACP_MODEL_UNSUPPORTED" && isRequestedModelUnsupportedReason(candidate.reason);
}
function supportsLegacyClaudeCodeModelMetadata(agentCommand) {
	if (!agentCommand) return false;
	const { command, args } = splitCommandLine(agentCommand);
	return isClaudeAcpCommand(command, args);
}
function modelStateFromLegacyResponse(response) {
	if (!response || typeof response !== "object") return;
	const models = response.models;
	if (!models || typeof models.currentModelId !== "string" || !Array.isArray(models.availableModels)) return;
	const availableModels = models.availableModels.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const candidate = entry;
		return typeof candidate.modelId === "string" && typeof candidate.name === "string" ? [{
			modelId: candidate.modelId,
			name: candidate.name
		}] : [];
	});
	return {
		currentModelId: models.currentModelId,
		availableModels
	};
}
function modelStateFromSessionResponse(params) {
	return modelStateFromConfigOptions(params.configOptions) ?? modelStateFromLegacyResponse(params.response);
}
function formatAvailableModelIds(models) {
	const ids = models?.availableModels.map((model) => model.modelId.trim()).filter((modelId) => modelId.length > 0) ?? [];
	return ids.length > 0 ? ids.join(", ") : "none advertised";
}
function resolveRequestedModelId(params) {
	if (!params.models || !isCursorAcpCommandForModelAlias(params.agentCommand)) return params.requestedModel;
	if (params.models.availableModels.some((model) => model.modelId === params.requestedModel)) return params.requestedModel;
	const candidates = params.models.availableModels.map((model) => model.modelId).filter((modelId) => modelId.startsWith(`${params.requestedModel}[`));
	if (candidates.length > 1) throw new RequestedModelUnsupportedError(`Cannot select model "${params.requestedModel}": multiple advertised Cursor models match (${candidates.join(", ")}). Use an exact advertised model ID.`, "unadvertised-model", { ambiguous: true });
	return candidates.length === 1 ? candidates[0] : params.requestedModel;
}
function resolveRequestedConfigOption(params) {
	const modelConfigId = params.models?.configId;
	return {
		modelConfigId,
		resolvedValue: modelConfigId === params.configId ? resolveRequestedModelId({
			...params,
			requestedModel: params.value
		}) : params.value
	};
}
function isCursorAcpCommandForModelAlias(agentCommand) {
	if (!agentCommand) return false;
	const { command, args } = splitCommandLine(agentCommand);
	return isCursorAcpCommand(command, args);
}
function assertRequestedModelSupported(params) {
	if (!params.models) {
		if (supportsLegacyClaudeCodeModelMetadata(params.agentCommand)) return;
		throw new RequestedModelUnsupportedError(`Cannot ${params.context === "replay" ? "replay saved model" : "apply --model"} "${params.requestedModel}": the ACP agent did not advertise model support through a session config option or legacy models metadata, and the adapter does not support a startup model flag.`, "missing-capability");
	}
	if (!new Set(params.models.availableModels.map((model) => model.modelId)).has(params.requestedModel)) {
		const resolvedModel = resolveRequestedModelId(params);
		if (resolvedModel !== params.requestedModel) return `Cursor ACP advertised "${resolvedModel}" for requested model "${params.requestedModel}"; using the advertised id.`;
		if (supportsLegacyClaudeCodeModelMetadata(params.agentCommand)) return `requested model "${params.requestedModel}" was not in the Claude ACP advertised model list (${formatAvailableModelIds(params.models)}); forwarding it to Claude Code so the adapter can accept or reject it.`;
		throw new RequestedModelUnsupportedError(`Cannot ${params.context === "replay" ? "replay saved model" : "apply --model"} "${params.requestedModel}": the ACP agent did not advertise that model. Available models: ${formatAvailableModelIds(params.models)}.`, "unadvertised-model");
	}
}
// src/acp/ndjson-stream.ts
const DEFAULT_MAX_ACP_MESSAGE_BYTES = 67108864;
var AcpMessageLimitError = class extends AcpxOperationalError {
	constructor(limit) {
		super(`ACP message exceeded ACPX_MAX_ACP_MESSAGE_BYTES (${limit} bytes). Increase the limit or set it to 0 for unlimited input.`, {
			outputCode: "RUNTIME",
			detailCode: "ACP_MESSAGE_TOO_LARGE",
			origin: "acp",
			retryable: false
		});
	}
};
function readMaxAcpMessageBytes(raw = process.env.ACPX_MAX_ACP_MESSAGE_BYTES) {
	const value = raw?.trim();
	if (!value) return DEFAULT_MAX_ACP_MESSAGE_BYTES;
	const bytes = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(bytes)) throw new Error("ACPX_MAX_ACP_MESSAGE_BYTES must be a non-negative safe integer; zero is unlimited");
	return bytes === 0 ? void 0 : bytes;
}
function countLineBytes(chunk, retained, limit) {
	let start = 0;
	while (start < chunk.length) {
		const newline = chunk.indexOf(10, start);
		const end = newline < 0 ? chunk.length : newline;
		retained += end - start;
		if (retained > limit) throw new AcpMessageLimitError(limit);
		if (newline < 0) return retained;
		retained = 0;
		start = end + 1;
	}
	return retained;
}
function parseAcpJsonMessageLine(line) {
	const message = JSON.parse(line);
	return isAcpMessageObject(message) ? message : void 0;
}
function enqueueNdJsonLine(agentCommand, line, controller) {
	const trimmedLine = line.trim();
	if (!trimmedLine || shouldIgnoreNonJsonAgentOutputLine(agentCommand, trimmedLine)) return;
	try {
		const message = parseAcpJsonMessageLine(trimmedLine);
		if (message) controller.enqueue(message);
	} catch (err) {
		console.error("Failed to parse JSON message:", trimmedLine, err);
	}
}
function enqueueNdJsonChunk(agentCommand, chunk, fragments, controller) {
	const lines = chunk.split("\n");
	const suffix = lines.pop() || "";
	if (lines.length > 0 && fragments.length > 0) {
		lines[0] = fragments.join("") + lines[0];
		fragments.length = 0;
	}
	for (const line of lines) enqueueNdJsonLine(agentCommand, line, controller);
	if (suffix) fragments.push(suffix);
}
function createNdJsonMessageStream(agentCommand, output, input, maxMessageBytes, onReadError) {
	const textEncoder = new TextEncoder();
	const textDecoder = new TextDecoder();
	return {
		readable: new ReadableStream({ async start(controller) {
			const fragments = [];
			let retainedBytes = 0;
			const reader = input.getReader();
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					if (maxMessageBytes !== void 0) retainedBytes = countLineBytes(value, retainedBytes, maxMessageBytes);
					enqueueNdJsonChunk(agentCommand, textDecoder.decode(value, { stream: true }), fragments, controller);
				}
				controller.close();
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err));
				controller.error(error);
				onReadError?.(error);
			} finally {
				reader.releaseLock();
			}
		} }),
		writable: new WritableStream({ async write(message) {
			const content = JSON.stringify(message) + "\n";
			const writer = output.getWriter();
			try {
				await writer.write(textEncoder.encode(content));
			} finally {
				writer.releaseLock();
			}
		} })
	};
}
// src/acp/observed-stream.ts
function observeAcpStream(base, options) {
	const elicitationRequestIds = /* @__PURE__ */ new Set();
	const shouldSuppressInboundReplaySessionUpdate = (message) => {
		return options.suppressReplaySessionUpdates() && isSessionUpdateNotification(message);
	};
	const observeInbound = (message) => {
		const requestId = elicitationRequestId(message);
		if (requestId !== void 0) {
			elicitationRequestIds.add(requestId);
			return;
		}
		if (!shouldSuppressInboundReplaySessionUpdate(message)) options.onMessage("inbound", message);
	};
	return {
		readable: new ReadableStream({ async start(controller) {
			const reader = base.readable.getReader();
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					if (!value) continue;
					observeInbound(value);
					if (isExtensionNotification(value)) continue;
					controller.enqueue(value);
				}
			} finally {
				reader.releaseLock();
				controller.close();
			}
		} }),
		writable: new WritableStream({ async write(message) {
			const promptOwner = promptRequestOwner(message);
			const activePrompt = promptOwner ? options.bindPromptOwner(promptOwner) : void 0;
			const id = responseId(message);
			if (!(id !== void 0 && elicitationRequestIds.delete(id))) options.onMessage("outbound", message);
			if (activePrompt) options.assertPromptActive(activePrompt);
			const writer = base.writable.getWriter();
			try {
				await writer.write(message);
			} finally {
				writer.releaseLock();
			}
			if (activePrompt && promptOwner) options.onPromptRequestWritten(activePrompt, promptOwner);
		} })
	};
}
function isExtensionNotification(message) {
	if (!("method" in message) || "id" in message || typeof message.method !== "string") return false;
	return message.method !== methods.client.session.update && message.method !== methods.client.elicitation.complete && message.method !== methods.protocol.cancelRequest;
}
function elicitationRequestId(message) {
	if (!("method" in message) || message.method !== methods.client.elicitation.create || !("id" in message)) return;
	return message.id;
}
function responseId(message) {
	if (!("id" in message) || "method" in message) return;
	return message.id;
}
function promptRequestOwner(message) {
	if (!("method" in message) || message.method !== methods.agent.session.prompt || !("id" in message)) return;
	const sessionId = message.params?.sessionId;
	return typeof sessionId === "string" ? {
		requestId: message.id,
		sessionId
	} : void 0;
}
// src/acp/session-control-errors.ts
const SESSION_CONTROL_UNSUPPORTED_ACP_CODES = /* @__PURE__ */ new Set([-32601, -32602]);
function asRecord$1(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value;
}
function isLikelySessionControlUnsupportedError(acp) {
	if (SESSION_CONTROL_UNSUPPORTED_ACP_CODES.has(acp.code)) return true;
	if (acp.code !== -32603) return false;
	const details = asRecord$1(acp.data)?.details;
	return typeof details === "string" && details.toLowerCase().includes("invalid params");
}
function formatSessionControlAcpSummary(acp) {
	const details = asRecord$1(acp.data)?.details;
	if (typeof details === "string" && details.trim().length > 0) return `${details.trim()} (ACP ${acp.code}, adapter reported "${acp.message}")`;
	return `${acp.message} (ACP ${acp.code})`;
}
function maybeWrapSessionControlError(method, error, context) {
	const acp = extractAcpError(error);
	if (!acp || !isLikelySessionControlUnsupportedError(acp)) return error;
	const acpSummary = formatSessionControlAcpSummary(acp);
	const message = `Agent rejected ${method}${context ? ` ${context}` : ""}: ${acpSummary}. The adapter may not implement ${method}, or the requested value is not supported.`;
	const wrapped = new Error(message, { cause: error instanceof Error ? error : void 0 });
	wrapped.acp = acp;
	return wrapped;
}
// src/acp/terminal-manager.ts
const DEFAULT_TERMINAL_OUTPUT_LIMIT_BYTES = 65536;
const DEFAULT_KILL_GRACE_MS = 1500;
function nowIso() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
function toCommandLine(command, args) {
	const renderedArgs = (args ?? []).map((arg) => JSON.stringify(arg)).join(" ");
	return renderedArgs.length > 0 ? `${command} ${renderedArgs}` : command;
}
function toEnvObject(env, inheritedEnv) {
	if (!env?.length && !hasInheritedEnvPolicy(inheritedEnv)) return;
	const merged = inheritParentEnvironment(inheritedEnv);
	for (const entry of env ?? []) merged[entry.name] = entry.value;
	return merged;
}
function buildTerminalSpawnOptions(command, cwd, env, platform = process.platform, inheritedEnv) {
	const resolvedEnv = toEnvObject(env, inheritedEnv);
	return buildSpawnCommandOptions(command, {
		cwd,
		env: resolvedEnv,
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		],
		windowsHide: true
	}, platform, resolvedEnv ?? process.env, cwd);
}
function readTerminalOutputCeiling() {
	const raw = process.env.ACPX_TERMINAL_MAX_OUTPUT_BYTES?.trim();
	if (!raw) return;
	const bytes = Number(raw);
	if (!/^\d+$/.test(raw) || !Number.isSafeInteger(bytes)) throw new Error("ACPX_TERMINAL_MAX_OUTPUT_BYTES must be a non-negative safe integer; zero disables the host ceiling");
	return bytes === 0 ? void 0 : bytes;
}
function resolveTerminalOutputLimit(requested, ceiling) {
	return Math.min(Math.max(0, Math.round(requested ?? DEFAULT_TERMINAL_OUTPUT_LIMIT_BYTES)), ceiling ?? Number.POSITIVE_INFINITY);
}
function tracksTerminalDescendants(terminal) {
	return terminal.killProcessGroup || terminal.descendants !== void 0;
}
function createTerminalDescendants(proc, killProcessGroup) {
	return process.platform === "win32" && killProcessGroup ? void 0 : new ProcessDescendants(proc, { ownProcessGroup: true });
}
function trimToUtf8Boundary(buffer, limit) {
	if (limit <= 0) return Buffer.alloc(0);
	let start = Math.max(0, buffer.length - limit);
	while (start < buffer.length && (buffer[start] & 192) === 128) start += 1;
	if (start >= buffer.length) return Buffer.alloc(0);
	return buffer.subarray(start);
}
async function defaultConfirmExecute(commandLine, signal) {
	return await promptForPermission({
		prompt: `\n[permission] Allow terminal command "${commandLine}"? (y/N) `,
		signal
	});
}
function canPromptForPermission() {
	return process.stdin.isTTY && process.stderr.isTTY;
}
function waitMs(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, Math.max(0, ms));
	});
}
function onStreamError() {}
var TerminalManager = class {
	cwd;
	inheritedEnv;
	permissionMode;
	nonInteractivePermissions;
	onOperation;
	usesDefaultConfirmExecute;
	confirmExecute;
	killGraceMs;
	processHelperTimeoutMs;
	outputCeilingBytes;
	terminals = /* @__PURE__ */ new Map();
	creations = /* @__PURE__ */ new Map();
	constructor(options) {
		this.outputCeilingBytes = readTerminalOutputCeiling();
		this.cwd = options.cwd;
		this.inheritedEnv = options.inheritedEnv;
		this.permissionMode = options.permissionMode;
		this.nonInteractivePermissions = options.nonInteractivePermissions ?? "deny";
		this.onOperation = options.onOperation;
		this.usesDefaultConfirmExecute = options.confirmExecute == null;
		this.confirmExecute = options.confirmExecute ?? defaultConfirmExecute;
		const killGraceMs = Math.max(0, Math.round(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS));
		this.killGraceMs = Number.isFinite(killGraceMs) && killGraceMs <= 2147483647 ? killGraceMs : 1;
		this.processHelperTimeoutMs = Math.max(1, Math.round(options.processHelperTimeoutMs ?? 8e3));
	}
	updatePermissionPolicy(permissionMode, nonInteractivePermissions) {
		this.permissionMode = permissionMode;
		this.nonInteractivePermissions = nonInteractivePermissions ?? "deny";
	}
	createTerminal(params, authority) {
		const creation = {};
		const pending = Promise.resolve().then(() => this.create(params, authority, creation));
		this.creations.set(pending, creation);
		const remove = () => this.creations.delete(pending);
		pending.then(remove, remove);
		return pending;
	}
	async create(params, authority, creation) {
		assertControlAuthority(authority);
		const commandLine = toCommandLine(params.command, params.args);
		const summary = `terminal/create: ${commandLine}`;
		this.emitOperation({
			method: "terminal/create",
			status: "running",
			summary,
			timestamp: nowIso()
		});
		try {
			const approved = await this.isExecuteApproved(commandLine, authority?.signal);
			assertControlAuthority(authority);
			if (!approved) throw new PermissionDeniedError("Permission denied for terminal/create");
			const outputByteLimit = resolveTerminalOutputLimit(params.outputByteLimit, this.outputCeilingBytes);
			const { proc, spawnCommand } = await spawnTerminalProcess(params, {
				cwd: this.cwd,
				inheritedEnv: this.inheritedEnv
			}, authority);
			let resolveExit = () => {};
			const exitPromise = new Promise((resolve) => {
				resolveExit = resolve;
			});
			const terminal = {
				process: proc,
				killProcessGroup: spawnCommand.killProcessGroup,
				descendantPids: /* @__PURE__ */ new Set(),
				descendants: createTerminalDescendants(proc, spawnCommand.killProcessGroup),
				processHelperTimeoutMs: this.processHelperTimeoutMs,
				output: Buffer.alloc(0),
				truncated: false,
				outputByteLimit,
				exitCode: void 0,
				signal: void 0,
				exitPromise,
				resolveExit
			};
			const appendOutput = (chunk) => {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				if (bytes.length === 0) return;
				terminal.output = Buffer.concat([terminal.output, bytes]);
				terminal.truncated ||= terminal.output.length > terminal.outputByteLimit;
				if (terminal.truncated) terminal.output = trimToUtf8Boundary(terminal.output, terminal.outputByteLimit);
			};
			proc.stdout.on("data", appendOutput);
			proc.stderr.on("data", appendOutput);
			proc.stdout.on("error", onStreamError);
			proc.stderr.on("error", onStreamError);
			proc.once("exit", (exitCode, signal) => {
				terminal.exitCode = exitCode;
				terminal.signal = signal;
				terminal.processGroupSnapshotPromise = terminal.descendants ? terminal.descendants.capture(terminal.processHelperTimeoutMs).then(() => {}) : rememberProcessGroupPids(terminal);
				(async () => {
					await terminal.processGroupSnapshotPromise;
					terminal.processGroupSnapshotPromise = void 0;
					terminal.resolveExit({
						exitCode: exitCode ?? null,
						signal: signal ?? null
					});
				})();
			});
			const terminalId = randomUUID();
			this.terminals.set(terminalId, terminal);
			try {
				await terminal.descendants?.capture(terminal.processHelperTimeoutMs);
				assertControlAuthority(authority);
			} catch (error) {
				try {
					await this.releaseTerminal({
						terminalId,
						sessionId: params.sessionId
					});
				} catch (cleanupError) {
					creation.cleanupFailure = { error: cleanupError };
					throw cleanupError;
				}
				throw error;
			}
			this.emitOperation({
				method: "terminal/create",
				status: "completed",
				summary,
				details: `terminalId=${terminalId}`,
				timestamp: nowIso()
			});
			return { terminalId };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.emitOperation({
				method: "terminal/create",
				status: "failed",
				summary,
				details: message,
				timestamp: nowIso()
			});
			throw error;
		}
	}
	async terminalOutput(params) {
		const terminal = this.getTerminal(params.terminalId);
		if (!terminal) throw new Error(`Unknown terminal: ${params.terminalId}`);
		const hasExitStatus = terminal.exitCode !== void 0 || terminal.signal !== void 0;
		this.emitOperation({
			method: "terminal/output",
			status: "completed",
			summary: `terminal/output: ${params.terminalId}`,
			timestamp: nowIso()
		});
		return {
			output: terminal.output.toString("utf8"),
			truncated: terminal.truncated,
			exitStatus: hasExitStatus ? {
				exitCode: terminal.exitCode ?? null,
				signal: terminal.signal ?? null
			} : void 0
		};
	}
	async waitForTerminalExit(params) {
		const terminal = this.getTerminal(params.terminalId);
		if (!terminal) throw new Error(`Unknown terminal: ${params.terminalId}`);
		const response = await terminal.exitPromise;
		this.emitOperation({
			method: "terminal/wait_for_exit",
			status: "completed",
			summary: `terminal/wait_for_exit: ${params.terminalId}`,
			details: `exitCode=${response.exitCode ?? "null"}, signal=${response.signal ?? "null"}`,
			timestamp: nowIso()
		});
		return response;
	}
	async killTerminal(params) {
		const terminal = this.getTerminal(params.terminalId);
		if (!terminal) throw new Error(`Unknown terminal: ${params.terminalId}`);
		const summary = `terminal/kill: ${params.terminalId}`;
		this.emitOperation({
			method: "terminal/kill",
			status: "running",
			summary,
			timestamp: nowIso()
		});
		try {
			await this.killProcess(terminal);
			this.emitOperation({
				method: "terminal/kill",
				status: "completed",
				summary,
				timestamp: nowIso()
			});
			return {};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.emitOperation({
				method: "terminal/kill",
				status: "failed",
				summary,
				details: message,
				timestamp: nowIso()
			});
			throw error;
		}
	}
	async releaseTerminal(params) {
		const summary = `terminal/release: ${params.terminalId}`;
		this.emitOperation({
			method: "terminal/release",
			status: "running",
			summary,
			timestamp: nowIso()
		});
		const terminal = this.getTerminal(params.terminalId);
		if (!terminal) {
			this.emitOperation({
				method: "terminal/release",
				status: "completed",
				summary,
				details: "already released",
				timestamp: nowIso()
			});
			return {};
		}
		try {
			await this.killProcess(terminal);
			await terminal.exitPromise.catch(() => {});
			terminal.descendants?.retire();
			terminal.process.stdout.destroy();
			terminal.process.stderr.destroy();
			terminal.output = Buffer.alloc(0);
			this.terminals.delete(params.terminalId);
			this.emitOperation({
				method: "terminal/release",
				status: "completed",
				summary,
				timestamp: nowIso()
			});
			return {};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.emitOperation({
				method: "terminal/release",
				status: "failed",
				summary,
				details: message,
				timestamp: nowIso()
			});
			throw error;
		}
	}
	async shutdown() {
		const creations = [...this.creations];
		await Promise.allSettled(creations.map(([pending]) => pending));
		const results = await Promise.allSettled(Array.from(this.terminals.keys(), (terminalId) => this.releaseTerminal({
			terminalId,
			sessionId: "shutdown"
		})));
		const failures = creations.flatMap(([, creation]) => creation.cleanupFailure ? [creation.cleanupFailure.error] : []);
		for (const result of results) if (result.status === "rejected") failures.push(result.reason);
		if (failures.length > 0) throw new AggregateError(failures, "Terminal shutdown failed", { cause: failures[0] });
	}
	getTerminal(terminalId) {
		return this.terminals.get(terminalId);
	}
	emitOperation(operation) {
		this.onOperation?.(operation);
	}
	async isExecuteApproved(commandLine, signal) {
		if (this.permissionMode === "approve-all") return true;
		if (this.permissionMode === "deny-all") return false;
		if (this.usesDefaultConfirmExecute && this.nonInteractivePermissions === "fail" && !canPromptForPermission()) throw new PermissionPromptUnavailableError();
		return await this.confirmExecute(commandLine, signal);
	}
	isRunning(terminal) {
		return terminal.exitCode === void 0 && terminal.signal === void 0;
	}
	async killProcess(terminal) {
		if (!this.isRunning(terminal) && !tracksTerminalDescendants(terminal)) return;
		try {
			await this.signalProcess(terminal, "SIGTERM");
		} catch {
			return;
		}
		if (await this.waitForCleanupAfterSignal(terminal) && (!terminal.killProcessGroup || terminal.descendants)) return;
		try {
			await this.signalProcess(terminal, "SIGKILL");
		} catch {
			return;
		}
		await this.waitForFinalCleanup(terminal);
	}
	async signalProcess(terminal, signal) {
		if (terminal.descendants) {
			await terminal.descendants.signal(signal, terminal.processHelperTimeoutMs);
			if (this.isRunning(terminal)) terminal.process.kill(signal);
			return;
		}
		const pid = terminal.process.pid;
		if (terminal.killProcessGroup && pid && process.platform === "win32") {
			await this.signalWindowsProcessGroup(terminal, pid, signal);
			return;
		}
		terminal.process.kill(signal);
	}
	async signalWindowsProcessGroup(terminal, pid, signal) {
		await this.captureDescendantPids(terminal, pid);
		if (this.isRunning(terminal)) {
			await killWindowsProcessTree(pid, signal, terminal.processHelperTimeoutMs);
			return;
		}
		for (const descendantPid of terminal.descendantPids) await killWindowsProcessTree(descendantPid, signal, terminal.processHelperTimeoutMs);
	}
	async captureDescendantPids(terminal, pid) {
		if (!this.isRunning(terminal)) await terminal.processGroupSnapshotPromise?.catch(() => {});
		for (const descendantPid of await listDescendantPids(pid, terminal.processHelperTimeoutMs)) terminal.descendantPids.add(descendantPid);
	}
	async waitForFinalCleanup(terminal) {
		if (!await this.waitForCleanupAfterSignal(terminal) && process.platform === "win32") throw new Error("Terminal process cleanup did not finish after SIGKILL");
	}
	async waitForCleanupAfterSignal(terminal) {
		const deadline = performance.now() + this.killGraceMs;
		while (this.isRunning(terminal) || terminal.processGroupSnapshotPromise || await hasLiveTerminalDescendants(terminal, deadline - performance.now()) || hasLivePid(terminal.descendantPids)) {
			const remaining = deadline - performance.now();
			if (remaining <= 0) return false;
			await waitMs(Math.min(25, remaining));
		}
		return true;
	}
};
async function spawnTerminalProcess(params, context, authority) {
	const directCommand = buildTerminalSpawnCommand(params.command, params.args);
	try {
		return {
			proc: await spawnAndWait(directCommand, params, context, authority),
			spawnCommand: directCommand
		};
	} catch (error) {
		const fallbackCommand = params.args === void 0 && isNotFoundSpawnError(error) ? buildTerminalFallbackSpawnCommand(params.command, params.cwd ?? context.cwd) : void 0;
		if (!fallbackCommand) throw error;
		return {
			proc: await spawnAndWait(fallbackCommand, params, context, authority),
			spawnCommand: fallbackCommand
		};
	}
}
async function spawnAndWait(spawnCommand, params, context, authority) {
	const spawnOptions = buildTerminalSpawnOptions(spawnCommand.command, params.cwd ?? context.cwd, params.env, process.platform, context.inheritedEnv);
	if (process.platform !== "win32") spawnOptions.detached = true;
	assertControlAuthority(authority);
	const proc = spawn(spawnCommand.command, spawnCommand.args, spawnOptions);
	await waitForSpawn(proc);
	return proc;
}
function isNotFoundSpawnError(error) {
	return error instanceof Error && error.code === "ENOENT";
}
function buildTerminalFallbackSpawnCommand(command, cwd, platform = process.platform) {
	if (commandPathExists(command, cwd)) return;
	if (platform === "win32") return hasWindowsShellSyntax(command) || /\s/u.test(command) ? buildTerminalShellSpawnCommand(command, platform) : void 0;
	if (hasShellSyntax(command) || /\s/u.test(command)) return buildTerminalShellSpawnCommand(command, platform);
}
function hasShellSyntax(command) {
	return /[|&;<>()>$`*?[\]{}'"\\\r\n]/u.test(command);
}
function hasWindowsShellSyntax(command) {
	return /[|&;<>()>$`*?[\]{}'"\r\n]/u.test(command);
}
function commandPathExists(command, cwd) {
	if (!/[\\/]/u.test(command)) return false;
	const resolvedPath = path.isAbsolute(command) ? command : path.resolve(cwd, command);
	return fs.existsSync(resolvedPath);
}
async function listDescendantPids(rootPid, timeoutMs) {
	let output;
	try {
		output = await runWindowsProcessListCommand(timeoutMs);
	} catch {
		return [];
	}
	const childrenByParent = /* @__PURE__ */ new Map();
	for (const line of output.split("\n")) addProcessListLine(childrenByParent, line);
	const descendants = [];
	const queue = [...childrenByParent.get(rootPid) ?? []];
	for (let index = 0; index < queue.length; index += 1) {
		const pid = queue[index];
		descendants.push(pid);
		queue.push(...childrenByParent.get(pid) ?? []);
	}
	return descendants;
}
function addProcessListLine(childrenByParent, line) {
	const parsed = parseProcessListLine(line);
	if (!parsed) return;
	const children = childrenByParent.get(parsed.parentPid);
	if (children) children.push(parsed.pid);
	else childrenByParent.set(parsed.parentPid, [parsed.pid]);
}
function parseProcessListLine(line) {
	const match = line.trim().match(/^(\d+)\s+(\d+)$/);
	if (!match) return;
	const pid = Number(match[1]);
	const parentPid = Number(match[2]);
	if (!Number.isInteger(pid) || !Number.isInteger(parentPid) || pid <= 0 || parentPid <= 0) return;
	return {
		pid,
		parentPid
	};
}
async function rememberProcessGroupPids(terminal) {
	const processGroupId = terminal.process.pid;
	if (!terminal.killProcessGroup || !processGroupId) return;
	for (const pid of await listDescendantPids(processGroupId, terminal.processHelperTimeoutMs)) terminal.descendantPids.add(pid);
}
async function runWindowsProcessListCommand(timeoutMs) {
	const command = ["Get-CimInstance Win32_Process |", "ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"].join(" ");
	return await runTimedExecFile("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		command
	], {
		timeoutMs,
		windowsHide: true
	});
}
async function killWindowsProcessTree(pid, signal, timeoutMs = PROCESS_HELPER_TIMEOUT_MS) {
	const args = [
		"/pid",
		String(pid),
		"/t"
	];
	if (signal === "SIGKILL") args.push("/f");
	try {
		await runTimedExecFile("taskkill", args, {
			timeoutMs,
			windowsHide: true
		});
	} catch {}
}
async function hasLiveTerminalDescendants(terminal, timeoutMs) {
	const descendants = terminal.descendants;
	if (!descendants) return false;
	if (timeoutMs > 0) await descendants.capture(Math.min(terminal.processHelperTimeoutMs, timeoutMs));
	return descendants.hasTrackedProcesses();
}
function hasLivePid(pids) {
	for (const pid of pids) try {
		process.kill(pid, 0);
		return true;
	} catch {
		pids.delete(pid);
	}
	return false;
}
// src/acp/client.ts
const REPLAY_IDLE_MS = 80;
const REPLAY_DRAIN_TIMEOUT_MS = 5e3;
const DRAIN_POLL_INTERVAL_MS = 20;
const AGENT_CLOSE_TERM_GRACE_MS = 1500;
const AGENT_CLOSE_KILL_GRACE_MS = 1e3;
const AGENT_CLEANUP_BUDGET_MS = 8e3;
const STARTUP_STDERR_MAX_CHARS = 8192;
const ELICITATION_CANCEL_MESSAGES = {
	inactive: "elicitation owner is no longer active",
	unavailable: "elicitation handler is unavailable",
	unsupported: "elicitation mode is not supported",
	mismatchedSession: "elicitation session is not active",
	cancelled: "elicitation request was cancelled",
	requestScoped: "request-scoped elicitation has no owner"
};
function normalizeElicitationModes(modes) {
	return [...new Set((modes ?? []).filter((mode) => mode === "form" || mode === "url"))];
}
function cancelledElicitationResponse(message) {
	return {
		action: "cancel",
		_meta: { message }
	};
}
function isKnownElicitationResponse(response) {
	if (!response || typeof response !== "object") return false;
	const action = response.action;
	return action === "accept" || action === "decline" || action === "cancel";
}
function elicitationSessionId(request) {
	const value = request.sessionId;
	return typeof value === "string" ? value : void 0;
}
function elicitationRequestScopeId(request) {
	const value = request.requestId;
	return value === null || typeof value === "string" || typeof value === "number" ? value : void 0;
}
async function raceWithAbort(signal, pending) {
	let onAbort;
	const aborted = new Promise((resolve) => {
		onAbort = () => resolve(void 0);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([pending, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
function hasResponseField(response, field) {
	return !!response && typeof response === "object" && field in response;
}
function normalizeResponseConfigOptions(response) {
	if (!response || !("configOptions" in response)) return;
	return Array.isArray(response.configOptions) ? response.configOptions : void 0;
}
function normalizeConfigOptionAcknowledgement(response) {
	if (!response || typeof response !== "object" || Array.isArray(response)) return {};
	if (Array.isArray(response.configOptions)) return response;
	const acknowledgement = { ...response };
	delete acknowledgement.configOptions;
	return acknowledgement;
}
function toReconnectedSessionResult(response) {
	const configOptions = normalizeResponseConfigOptions(response);
	return {
		agentSessionId: extractAgentSessionId(response?._meta),
		configOptions,
		models: modelStateFromSessionResponse({
			configOptions,
			response
		}),
		configOptionsPresent: configOptions !== void 0,
		legacyModelMetadataPresent: hasResponseField(response, "models")
	};
}
function snapshotPermissionPolicy(policy) {
	if (!policy) return;
	return {
		...policy.autoApprove ? { autoApprove: [...policy.autoApprove] } : {},
		...policy.autoDeny ? { autoDeny: [...policy.autoDeny] } : {},
		...policy.escalate ? { escalate: [...policy.escalate] } : {},
		...policy.defaultAction ? { defaultAction: policy.defaultAction } : {}
	};
}
function snapshotProcessLaunchScope(scope) {
	if (!scope || scope.kind === "client") return Object.freeze({ kind: "client" });
	if (scope.kind === "runtime-session") return Object.freeze({
		kind: "runtime-session",
		sessionKey: scope.sessionKey
	});
	return Object.freeze({
		kind: "runtime-probe",
		agent: scope.agent
	});
}
function childProcessIsRunning(agent) {
	if (!agent) return false;
	return agent.exitCode == null && agent.signalCode == null && !agent.killed;
}
function cancelledPermissionResponse() {
	return { outcome: { outcome: "cancelled" } };
}
var AcpClient = class {
	options;
	connection;
	agent;
	agentDescendants = /* @__PURE__ */ new WeakMap();
	agentCleanups = /* @__PURE__ */ new WeakMap();
	commandProbes = /* @__PURE__ */ new Set();
	initResult;
	loadedSessionId;
	eventHandlers;
	permissionStats = {
		requested: 0,
		approved: 0,
		denied: 0,
		cancelled: 0
	};
	filesystem;
	terminalManager;
	sessionUpdateChain = Promise.resolve();
	observedSessionUpdates = 0;
	processedSessionUpdates = 0;
	suppressSessionUpdates = false;
	suppressReplaySessionUpdateMessages = false;
	activePrompt;
	pendingPromptOwners = [];
	cancellingSessionIds = /* @__PURE__ */ new Set();
	permissionAbortControllers = /* @__PURE__ */ new Map();
	closing = false;
	closeTask;
	closeEpoch = 0;
	agentStartedAt;
	lastAgentExit;
	lastKnownPid;
	promptPermissionFailures = /* @__PURE__ */ new Map();
	pendingConnectionRequests = /* @__PURE__ */ new Set();
	constructor(options) {
		this.options = {
			...options,
			cwd: asAbsoluteCwd(options.cwd),
			agentProcessEnv: options.agentProcessEnv ? { ...options.agentProcessEnv } : void 0,
			agentProcessEnvAllow: snapshotEnvNames("agentProcessEnvAllow", options.agentProcessEnvAllow),
			agentProcessEnvBlock: snapshotEnvNames("agentProcessEnvBlock", options.agentProcessEnvBlock),
			authPolicy: options.authPolicy ?? "skip",
			permissionPolicy: snapshotPermissionPolicy(options.permissionPolicy),
			elicitationModes: normalizeElicitationModes(options.elicitationModes)
		};
		this.eventHandlers = {
			onAcpMessage: this.options.onAcpMessage,
			onAcpOutputMessage: this.options.onAcpOutputMessage,
			onSessionUpdate: this.options.onSessionUpdate,
			onClientOperation: this.options.onClientOperation,
			onPermissionEscalation: this.options.onPermissionEscalation
		};
		this.filesystem = new FileSystemHandlers({
			cwd: this.options.cwd,
			permissionMode: this.options.permissionMode,
			nonInteractivePermissions: this.options.nonInteractivePermissions,
			onOperation: (operation) => {
				this.eventHandlers.onClientOperation?.(operation);
			}
		});
		this.terminalManager = new TerminalManager({
			cwd: this.options.cwd,
			inheritedEnv: this.inheritedEnvPolicy(),
			permissionMode: this.options.permissionMode,
			nonInteractivePermissions: this.options.nonInteractivePermissions,
			onOperation: (operation) => {
				this.eventHandlers.onClientOperation?.(operation);
			}
		});
	}
	get initializeResult() {
		return this.initResult;
	}
	getAgentPid() {
		return this.agent?.pid ?? this.lastKnownPid;
	}
	getPermissionStats() {
		return { ...this.permissionStats };
	}
	getAgentLifecycleSnapshot() {
		const pid = this.agent?.pid ?? this.lastKnownPid;
		const running = childProcessIsRunning(this.agent);
		return {
			pid,
			startedAt: this.agentStartedAt,
			running,
			lastExit: this.lastAgentExit ? { ...this.lastAgentExit } : void 0
		};
	}
	supportsLoadSession() {
		return Boolean(this.initResult?.agentCapabilities?.loadSession);
	}
	supportsResumeSession() {
		return Boolean(this.initResult?.agentCapabilities?.sessionCapabilities?.resume);
	}
	supportsCloseSession() {
		return Boolean(this.initResult?.agentCapabilities?.sessionCapabilities?.close);
	}
	supportsListSessions() {
		return Boolean(this.initResult?.agentCapabilities?.sessionCapabilities?.list);
	}
	setEventHandlers(handlers) {
		this.eventHandlers = { ...handlers };
	}
	clearEventHandlers() {
		this.eventHandlers = {};
	}
	updateRuntimeOptions(options) {
		const shouldRefreshPermissionPolicy = options.permissionMode !== void 0 || options.nonInteractivePermissions !== void 0;
		if (options.permissionMode) this.options.permissionMode = options.permissionMode;
		if (options.nonInteractivePermissions !== void 0) this.options.nonInteractivePermissions = options.nonInteractivePermissions;
		if (Object.prototype.hasOwnProperty.call(options, "permissionPolicy")) this.options.permissionPolicy = snapshotPermissionPolicy(options.permissionPolicy);
		this.updateClientCapabilityPreferences(options);
		this.refreshRuntimePermissionPolicy(shouldRefreshPermissionPolicy);
		if (options.suppressSdkConsoleErrors !== void 0) this.options.suppressSdkConsoleErrors = options.suppressSdkConsoleErrors;
		if (options.verbose !== void 0) this.options.verbose = options.verbose;
	}
	updateClientCapabilityPreferences(options) {
		if (options.fs !== void 0) this.options.fs = options.fs;
		if (options.terminal !== void 0) this.options.terminal = options.terminal;
	}
	refreshRuntimePermissionPolicy(enabled) {
		if (!enabled) return;
		this.filesystem.updatePermissionPolicy(this.options.permissionMode, this.options.nonInteractivePermissions);
		this.terminalManager.updatePermissionPolicy(this.options.permissionMode, this.options.nonInteractivePermissions);
	}
	hasLiveConnection() {
		return !this.closing && this.connection != null && !this.connection.signal.aborted && this.agent != null && isChildProcessRunning(this.agent);
	}
	hasReusableSession(sessionId) {
		return this.hasLiveConnection() && this.loadedSessionId === sessionId;
	}
	hasActivePrompt(sessionId) {
		if (!this.activePrompt) return false;
		if (sessionId == null) return true;
		return this.activePrompt.sessionId === sessionId;
	}
	hasUnresolvedPrompt() {
		return this.activePrompt !== void 0;
	}
	abortSessionRequests(sessionId) {
		const owners = this.pendingPromptOwners.filter((owner) => owner.sessionId === sessionId);
		const fallback = this.takePermissionAbortController(sessionId);
		for (const owner of owners) {
			owner.elicitationHandler = void 0;
			owner.elicitationController.abort();
			owner.requestController.abort();
		}
		fallback?.abort();
	}
	async start(authority, options) {
		assertControlAuthority(authority);
		if (options) this.options.sessionOptions = structuredClone(options.sessionOptions);
		if (this.hasLiveConnection()) return;
		const epoch = await this.waitForPreviousClose();
		const maxMessageBytes = readMaxAcpMessageBytes();
		const launch = await this.resolveAgentLaunchPlan(epoch, authority);
		this.assertCommandProbeActive(epoch, authority);
		this.logAgentLaunch(launch);
		await this.ensureLaunchSupport(launch);
		this.assertCommandProbeActive(epoch, authority);
		const { child, process: startedProcess } = await this.spawnAgentProcess(launch, authority);
		if (this.closeEpoch === epoch) {
			this.agent = child;
			this.closing = false;
			this.agentStartedAt = startedProcess.startedAt;
			this.lastAgentExit = void 0;
			this.lastKnownPid = startedProcess.pid;
		}
		const startupStderr = [];
		child.stderr.on("data", (chunk) => {
			this.captureStartupStderr(startupStderr, chunk);
			if (!this.options.verbose) return;
			process.stderr.write(chunk);
		});
		const startupFailure = this.createStartupFailureWatcher(child, startupStderr);
		try {
			await this.admitAndObserveSpawnedProcess(child, startedProcess);
			const admissionExit = startupFailure.getError();
			if (admissionExit) throw admissionExit;
		} catch (error) {
			startupFailure.dispose();
			throw error;
		}
		await this.stopIfClosedDuringLaunch(epoch, child, startupFailure, authority);
		const input = Writable.toWeb(child.stdin);
		const output = Readable.toWeb(child.stdout);
		let connection;
		const stream = this.createTappedStream(createNdJsonMessageStream(this.options.agentCommand, input, output, maxMessageBytes, (error) => {
			this.rejectPendingConnectionRequests(error);
			connection?.close(error);
		}));
		const capabilities = resolveClientCapabilities({
			devinAcp: launch.devinAcp,
			fs: this.options.fs !== false,
			terminal: this.options.terminal !== false,
			elicitationModes: this.options.elicitationModes
		});
		connection = this.createConnection(stream, launch, capabilities);
		const onConnectionClose = () => {
			this.handleAgentDisconnect(child, "connection_close", child.exitCode ?? null, child.signalCode ?? null);
		};
		connection.signal.addEventListener("abort", onConnectionClose, { once: true });
		await this.initializeAgentConnection({
			child,
			connection,
			startupFailure,
			startupStderr,
			launch,
			capabilities
		});
		if (connection.signal.aborted) onConnectionClose();
	}
	async waitForPreviousClose() {
		const cleanup = this.closeTask ?? (this.connection || this.agent ? this.close() : void 0);
		const epoch = this.closeEpoch;
		await cleanup;
		if (this.closeEpoch !== epoch) throw new Error("ACP client was closed while the agent was starting");
		return epoch;
	}
	async resolveAgentLaunchPlan(epoch, authority) {
		const configuredCommand = resolveAgentCommandParts(this.options.agentCommand, this.options.agentArgv);
		const resolvedBuiltInLaunch = resolveBuiltInAgentLaunch(this.options.agentCommand);
		const spawnCommand = resolvedBuiltInLaunch?.command ?? configuredCommand.command;
		const spawnOptions = buildAgentSpawnOptions(this.options.cwd, this.options.authCredentials, this.options.sessionOptions?.env, this.options.agentProcessEnv, this.inheritedEnvPolicy());
		const commandContext = {
			env: spawnOptions.env,
			readOutput: async (command, args, timeoutMs, diagnostic = false) => {
				try {
					const output = await this.readAgentCommandOutput(command, args, timeoutMs, spawnOptions, epoch, authority);
					await admitCommandProbe(() => this.assertCommandProbeActive(epoch, authority));
					return output;
				} catch (error) {
					if (error instanceof CommandProbeAdmissionError) {
						if (diagnostic) return;
						throw error.reason;
					}
					throw error;
				}
			}
		};
		let args = resolvedBuiltInLaunch?.args ?? configuredCommand.args;
		args = await resolveGeminiCommandArgs(spawnCommand, args, commandContext);
		if (isQoderAcpCommand(spawnCommand, args)) args = buildQoderAcpCommandArgs(args, this.options);
		return {
			spawnCommand,
			args,
			resolvedBuiltInLaunch,
			devinAcp: isDevinAcpCommand(spawnCommand, args),
			geminiAcp: isGeminiAcpCommand(spawnCommand, args),
			copilotAcp: isCopilotAcpCommand(spawnCommand, args),
			claudeAcp: isClaudeAcpCommand(spawnCommand, args),
			spawnOptions,
			commandContext
		};
	}
	logAgentLaunch(plan) {
		const launch = plan.resolvedBuiltInLaunch;
		if (launch?.source === "installed") {
			this.log(`spawning installed built-in agent ${launch.packageName}${launch.packageVersion ? `@${launch.packageVersion}` : ""} via ${plan.spawnCommand} ${plan.args.join(" ")}`);
			return;
		}
		if (launch?.source === "package-exec") {
			this.log(`spawning built-in agent ${launch.packageName}@${launch.packageRange} via current Node package exec bridge ${plan.spawnCommand} ${plan.args.join(" ")}`);
			return;
		}
		this.log(`spawning agent: ${plan.spawnCommand} ${plan.args.join(" ")}`);
	}
	async ensureLaunchSupport(plan) {
		if (plan.copilotAcp) await ensureCopilotAcpSupport(plan.spawnCommand, plan.commandContext);
		if (!plan.claudeAcp) return;
		const claudeExe = resolveClaudeCodeExecutable(process.platform, plan.spawnOptions.env, plan.spawnOptions.cwd);
		if (claudeExe) {
			plan.spawnOptions.env.CLAUDE_CODE_EXECUTABLE = claudeExe;
			this.log(`resolved system Claude Code executable: ${claudeExe}`);
		}
	}
	prepareProcessLaunch(command, args, options) {
		const resolved = buildAgentSpawnCommand(command, args, process.platform, options.env, options.cwd);
		return {
			launch: Object.freeze({
				launchId: randomUUID(),
				scope: snapshotProcessLaunchScope(this.options.processLaunchScope),
				command: resolved.command,
				args: Object.freeze([...resolved.args]),
				cwd: options.cwd
			}),
			windowsVerbatimArguments: resolved.windowsVerbatimArguments
		};
	}
	startedProcess(launch, pid) {
		return Object.freeze({
			...launch,
			pid,
			startedAt: isoNow$2()
		});
	}
	async spawnAgentProcess(plan, authority) {
		const prepared = this.prepareProcessLaunch(plan.spawnCommand, plan.args, plan.spawnOptions);
		const { launch } = prepared;
		await this.options.processLifecycle?.onBeforeSpawn?.(launch);
		assertControlAuthority(authority);
		let spawnedChild;
		try {
			spawnedChild = spawn(launch.command, [...launch.args], {
				...plan.spawnOptions,
				windowsVerbatimArguments: prepared.windowsVerbatimArguments
			});
			await waitForSpawn(spawnedChild);
		} catch (error) {
			const spawnError = new AgentSpawnError(this.options.agentCommand, error);
			this.notifyProcessSpawnFailure(launch, spawnError);
			throw spawnError;
		}
		const child = requireAgentStdio(spawnedChild);
		this.agentDescendants.set(child, new ProcessDescendants(child));
		const pid = child.pid;
		if (pid === void 0) {
			const spawnError = new AgentSpawnError(this.options.agentCommand, /* @__PURE__ */ new Error("spawned agent process did not expose a PID"));
			this.notifyProcessSpawnFailure(launch, spawnError);
			await this.terminateAgentProcess(child);
			throw spawnError;
		}
		return {
			child,
			process: this.startedProcess(launch, pid)
		};
	}
	assertCommandProbeActive(epoch, authority) {
		assertControlAuthority(authority);
		if (this.closeEpoch !== epoch) throw new Error("ACP client was closed while the agent was starting");
	}
	async readAgentCommandOutput(command, args, timeoutMs, options, epoch, authority) {
		const prepared = this.prepareProcessLaunch(command, args, options);
		const { launch } = prepared;
		await admitCommandProbe(async () => {
			this.assertCommandProbeActive(epoch, authority);
			await this.options.processLifecycle?.onBeforeSpawn?.(launch);
		});
		try {
			this.assertCommandProbeActive(epoch, authority);
		} catch (error) {
			throw new CommandProbeAdmissionError(error);
		}
		let child;
		try {
			child = spawn(launch.command, [...launch.args], {
				cwd: options.cwd,
				env: options.env,
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				],
				windowsHide: true,
				windowsVerbatimArguments: prepared.windowsVerbatimArguments,
				detached: process.platform !== "win32"
			});
		} catch (error) {
			this.notifyProcessSpawnFailure(launch, new AgentSpawnError(command, error));
			return;
		}
		this.commandProbes.add(child);
		this.agentDescendants.set(child, new ProcessDescendants(child, { ownProcessGroup: true }));
		const capture = captureCommandProbeOutput(child, timeoutMs, () => this.terminateAgentProcess(child));
		try {
			try {
				await waitForSpawn(child);
			} catch (error) {
				this.notifyProcessSpawnFailure(launch, new AgentSpawnError(command, error));
				return;
			}
			if (child.pid === void 0) {
				this.notifyProcessSpawnFailure(launch, new AgentSpawnError(command, /* @__PURE__ */ new Error("spawned probe did not expose a PID")));
				return;
			}
			const started = this.startedProcess(launch, child.pid);
			await this.admitSpawnedProcess(child, (barrier) => this.attachProcessExitObserver(child, started, barrier), () => admitCommandProbe(async () => {
				await this.options.processLifecycle?.onSpawned?.(started);
				this.assertCommandProbeActive(epoch, authority);
			}));
			const output = await capture.result;
			await admitCommandProbe(() => this.assertCommandProbeActive(epoch, authority));
			return output;
		} finally {
			try {
				await this.terminateAgentProcess(child);
			} finally {
				capture.dispose();
				this.commandProbes.delete(child);
			}
		}
	}
	async admitAndObserveSpawnedProcess(child, process) {
		await this.admitSpawnedProcess(child, (barrier) => this.attachAgentLifecycleObservers(child, process, barrier), async () => {
			await this.options.processLifecycle?.onSpawned?.(process);
		});
	}
	async admitSpawnedProcess(child, observe, admit) {
		let releaseExitNotification = () => {};
		observe(new Promise((resolve) => {
			releaseExitNotification = resolve;
		}));
		try {
			await admit();
		} catch (error) {
			await this.terminateAgentProcess(child);
			throw error;
		} finally {
			releaseExitNotification();
		}
	}
	createConnection(stream, launch, capabilities) {
		const app = client({ name: "acpx" }).onNotification(methods.client.session.update, async ({ params }) => {
			await this.handleSessionUpdate(params);
		}).onNotification(methods.client.elicitation.complete, async () => {}).onRequest(methods.client.session.requestPermission, async ({ params, signal }) => {
			return await this.handlePermissionRequest(params, signal);
		}).onRequest(methods.client.elicitation.create, async ({ params, requestId, signal }) => {
			return await this.handleElicitationRequest(params, requestId, signal);
		});
		if (capabilities.fs?.readTextFile) app.onRequest(methods.client.fs.readTextFile, async ({ params, signal }) => {
			return await this.handleReadTextFile(params, signal);
		});
		if (capabilities.fs?.writeTextFile) app.onRequest(methods.client.fs.writeTextFile, async ({ params, signal }) => {
			return await this.handleWriteTextFile(params, signal);
		});
		if (capabilities.terminal) app.onRequest(methods.client.terminal.create, async ({ params, signal }) => {
			return await this.handleCreateTerminal(params, signal);
		}).onRequest(methods.client.terminal.output, async ({ params }) => {
			return await this.terminalManager.terminalOutput(params);
		}).onRequest(methods.client.terminal.waitForExit, async ({ params }) => {
			return await this.terminalManager.waitForTerminalExit(params);
		}).onRequest(methods.client.terminal.kill, async ({ params }) => {
			return await this.terminalManager.killTerminal(params);
		}).onRequest(methods.client.terminal.release, async ({ params }) => {
			return await this.terminalManager.releaseTerminal(params);
		});
		if (launch.devinAcp) app.onRequest("_cognition.ai/request_diagnostics", (params) => {
			return params && typeof params === "object" && !Array.isArray(params) ? params : {};
		}, async () => ({}));
		return app.connect(stream);
	}
	async initializeAgentConnection(params) {
		try {
			const initResult = await Promise.race([this.initializeProtocolConnection(params.connection, params.launch, params.capabilities), params.startupFailure.promise]);
			params.startupFailure.dispose();
			this.connection = params.connection;
			this.initResult = initResult;
			await this.captureAgentDescendants(params.child);
			this.log(`initialized protocol version ${initResult.protocolVersion}`);
		} catch (error) {
			params.connection.close(error);
			await this.handleInitializeFailure(params, error);
		}
	}
	async initializeProtocolConnection(connection, launch, capabilities) {
		const initializePromise = connection.agent.request(methods.agent.initialize, {
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: capabilities,
			clientInfo: resolveClientInfo(launch.devinAcp)
		});
		const initialized = launch.geminiAcp ? await withTimeout(initializePromise, resolveGeminiAcpStartupTimeoutMs()) : await initializePromise;
		await this.authenticateIfRequired(connection, initialized.authMethods ?? []);
		return initialized;
	}
	async handleInitializeFailure(params, error) {
		params.startupFailure.dispose();
		await this.captureAgentDescendants(params.child);
		const normalizedError = error instanceof AcpMessageLimitError ? error : await this.normalizeInitializeError(error, params.child, params.startupStderr);
		await this.terminateAgentProcess(params.child);
		if (params.launch.geminiAcp && error instanceof TimeoutError) throw new GeminiAcpStartupTimeoutError(await buildGeminiAcpStartupTimeoutMessage(params.launch.spawnCommand, params.launch.commandContext), {
			cause: error,
			retryable: true
		});
		throw normalizedError;
	}
	createTappedStream(base) {
		return observeAcpStream(base, {
			onMessage: (direction, message) => {
				this.eventHandlers.onAcpOutputMessage?.(direction, message);
				this.eventHandlers.onAcpMessage?.(direction, message);
			},
			suppressReplaySessionUpdates: () => this.suppressReplaySessionUpdateMessages,
			bindPromptOwner: (owner) => this.bindPromptOwner(owner),
			assertPromptActive: (active) => this.assertPromptActive(active),
			onPromptRequestWritten: (active, owner) => this.onPromptRequestWritten(active, owner)
		});
	}
	sessionMeta() {
		const { command, args } = resolveAgentCommandParts(this.options.agentCommand, this.options.agentArgv);
		return buildClaudeCodeOptionsMeta(this.options.sessionOptions, isClaudeAcpCommand(command, args));
	}
	async createSession(cwd = this.options.cwd, authority) {
		assertControlAuthority(authority);
		const connection = this.getConnection();
		const { command, args } = resolveAgentCommandParts(this.options.agentCommand, this.options.agentArgv);
		const claudeAcp = isClaudeAcpCommand(command, args);
		const sessionCwd = await resolveAgentSessionCwd(cwd, this.options.agentCommand);
		let result;
		try {
			const createPromise = this.runConnectionRequest(() => connection.agent.request(methods.agent.session.new, {
				cwd: sessionCwd,
				mcpServers: this.options.mcpServers ?? [],
				_meta: this.sessionMeta()
			}), authority);
			result = claudeAcp ? await withTimeout(createPromise, resolveClaudeAcpSessionCreateTimeoutMs()) : await createPromise;
		} catch (error) {
			if (claudeAcp && error instanceof TimeoutError) throw new ClaudeAcpSessionCreateTimeoutError(buildClaudeAcpSessionCreateTimeoutMessage(), {
				cause: error,
				retryable: true
			});
			throw error;
		}
		this.loadedSessionId = result.sessionId;
		const configOptions = normalizeResponseConfigOptions(result);
		const models = modelStateFromSessionResponse({
			configOptions,
			response: result
		});
		await this.captureAgentDescendants(this.agent);
		return {
			sessionId: result.sessionId,
			agentSessionId: extractAgentSessionId(result._meta),
			configOptions,
			models,
			configOptionsPresent: configOptions !== void 0,
			legacyModelMetadataPresent: hasResponseField(result, "models")
		};
	}
	async loadSession(sessionId, cwd = this.options.cwd) {
		this.getConnection();
		return await this.loadSessionWithOptions(sessionId, cwd, {});
	}
	async loadSessionWithOptions(sessionId, cwd = this.options.cwd, options = {}) {
		const connection = this.getConnection();
		const sessionCwd = await resolveAgentSessionCwd(cwd, this.options.agentCommand);
		assertControlAuthority(options.authority);
		const previousSuppression = this.applySessionUpdateSuppression(Boolean(options.suppressReplayUpdates));
		let response;
		try {
			response = await this.runConnectionRequest(() => connection.agent.request(methods.agent.session.load, {
				sessionId,
				cwd: sessionCwd,
				mcpServers: this.options.mcpServers ?? [],
				_meta: this.sessionMeta()
			}), options.authority);
			await this.waitForSessionUpdateDrain(options.replayIdleMs ?? REPLAY_IDLE_MS, options.replayDrainTimeoutMs ?? REPLAY_DRAIN_TIMEOUT_MS);
		} finally {
			this.restoreSessionUpdateSuppression(previousSuppression);
		}
		this.loadedSessionId = sessionId;
		const result = toReconnectedSessionResult(response);
		await this.captureAgentDescendants(this.agent);
		return result;
	}
	async resumeSession(sessionId, cwd = this.options.cwd, authority) {
		assertControlAuthority(authority);
		const connection = this.getConnection();
		const sessionCwd = await resolveAgentSessionCwd(cwd, this.options.agentCommand);
		const response = await this.runConnectionRequest(() => connection.agent.request(methods.agent.session.resume, {
			sessionId,
			cwd: sessionCwd,
			mcpServers: this.options.mcpServers ?? [],
			_meta: this.sessionMeta()
		}), authority);
		this.loadedSessionId = sessionId;
		const result = toReconnectedSessionResult(response);
		await this.captureAgentDescendants(this.agent);
		return result;
	}
	applySessionUpdateSuppression(enabled) {
		const previous = {
			suppressSessionUpdates: this.suppressSessionUpdates,
			suppressReplaySessionUpdateMessages: this.suppressReplaySessionUpdateMessages
		};
		this.suppressSessionUpdates = previous.suppressSessionUpdates || enabled;
		this.suppressReplaySessionUpdateMessages = previous.suppressReplaySessionUpdateMessages || enabled;
		return previous;
	}
	restoreSessionUpdateSuppression(previous) {
		this.suppressSessionUpdates = previous.suppressSessionUpdates;
		this.suppressReplaySessionUpdateMessages = previous.suppressReplaySessionUpdateMessages;
	}
	async prompt(sessionId, prompt, onRequestWritten, onElicitation, onPermissionRequest, authority) {
		const connection = this.getConnection();
		const normalizedPrompt = this.normalizePromptForAgent(prompt);
		const previousActivePrompt = this.activePrompt;
		const replacedOwners = this.pendingPromptOwners.filter((owner) => owner.sessionId === sessionId);
		const activePrompt = this.beginActivePrompt(sessionId, onRequestWritten, onElicitation, onPermissionRequest, authority);
		try {
			const promptPromise = this.runConnectionRequest(() => connection.agent.request(methods.agent.session.prompt, {
				sessionId,
				prompt: normalizedPrompt
			}), authority);
			activePrompt.promise = promptPromise;
			previousActivePrompt?.elicitationController?.abort();
			for (const owner of replacedOwners) owner.requestController.abort();
			return this.returnPromptResponseOrPermissionFailure(sessionId, await promptPromise);
		} catch (error) {
			if (activePrompt.admissionFailure) throw activePrompt.admissionFailure.error;
			this.throwPromptPermissionFailureIfPresent(sessionId);
			throw error;
		} finally {
			this.clearActivePrompt(activePrompt);
		}
	}
	beginActivePrompt(sessionId, onRequestWritten, elicitationHandler, permissionHandler, authority) {
		this.cancellingSessionIds.delete(sessionId);
		const active = {
			sessionId,
			onRequestWritten,
			authority,
			elicitationHandler,
			permissionHandler,
			elicitationController: new AbortController(),
			requestController: new AbortController()
		};
		this.activePrompt = active;
		this.pendingPromptOwners.push(active);
		return active;
	}
	bindPromptOwner(owner) {
		const active = this.pendingPromptOwners.find((candidate) => {
			return candidate.requestId === void 0 && candidate.sessionId === owner.sessionId;
		});
		if (active) active.requestId = owner.requestId;
		return active;
	}
	assertPromptActive(active) {
		try {
			assertControlAuthority(active.authority);
		} catch (error) {
			active.admissionFailure = { error };
			throw error;
		}
	}
	onPromptRequestWritten(active, owner) {
		if (active.requestId !== owner.requestId || active.sessionId !== owner.sessionId) return;
		try {
			Promise.resolve(active.onRequestWritten?.()).catch(() => {});
		} catch {}
	}
	clearActivePrompt(active) {
		const pendingIndex = this.pendingPromptOwners.indexOf(active);
		const clearSession = !this.pendingPromptOwners.some((candidate, index) => index > pendingIndex && candidate.sessionId === active.sessionId);
		if (this.activePrompt === active) this.activePrompt = void 0;
		if (pendingIndex >= 0) this.pendingPromptOwners.splice(pendingIndex, 1);
		let permissionController;
		if (clearSession) {
			this.cancellingSessionIds.delete(active.sessionId);
			permissionController = this.takePermissionAbortController(active.sessionId);
			this.promptPermissionFailures.delete(active.sessionId);
		}
		active.elicitationController.abort();
		active.requestController.abort();
		permissionController?.abort();
	}
	normalizePromptForAgent(prompt) {
		const normalizedPrompt = typeof prompt === "string" ? textPrompt(prompt) : prompt;
		const unsupportedPromptContent = getUnsupportedPromptContentMessage(normalizedPrompt, this.initResult?.agentCapabilities);
		if (unsupportedPromptContent) throw new UnsupportedPromptContentError(unsupportedPromptContent);
		return normalizedPrompt;
	}
	returnPromptResponseOrPermissionFailure(sessionId, response) {
		this.throwPromptPermissionFailureIfPresent(sessionId);
		return response;
	}
	throwPromptPermissionFailureIfPresent(sessionId) {
		const permissionFailure = this.consumePromptPermissionFailure(sessionId);
		if (permissionFailure) throw permissionFailure;
	}
	async setSessionMode(sessionId, modeId, authority) {
		const connection = this.getConnection();
		await this.runConnectionRequest(() => connection.agent.request(methods.agent.session.setMode, {
			sessionId,
			modeId
		}), authority, (error) => maybeWrapSessionControlError("session/set_mode", error, `for mode "${modeId}"`));
	}
	async setSessionConfigOption(sessionId, configId, value, models, authority) {
		assertControlAuthority(authority);
		const resolvedValue = models?.configId === configId ? this.resolveSessionModelId(value, models) : value;
		const connection = this.getConnection();
		return normalizeConfigOptionAcknowledgement(await this.runConnectionRequest(() => connection.agent.request(methods.agent.session.setConfigOption, {
			sessionId,
			configId,
			value: resolvedValue
		}), authority, (error) => maybeWrapSessionControlError("session/set_config_option", error, `for "${configId}"="${value}"`)));
	}
	async setSessionModel(sessionId, modelId, models, authority) {
		assertControlAuthority(authority);
		if (!models) throw new RequestedModelUnsupportedError(`Cannot set model "${modelId}": the ACP session did not advertise a model config option or legacy session/set_model support.`, "missing-capability");
		const resolvedModelId = this.resolveSessionModelId(modelId, models);
		return models.configId ? await this.setSessionModelThroughConfig(sessionId, resolvedModelId, models.configId, authority) : await this.setSessionModelThroughLegacyMethod(sessionId, resolvedModelId, authority);
	}
	resolveSessionModelId(modelId, models) {
		const params = {
			requestedModel: modelId,
			models,
			agentCommand: this.options.agentCommand
		};
		assertRequestedModelSupported({
			...params,
			context: "apply"
		});
		return resolveRequestedModelId(params);
	}
	async setSessionModelThroughConfig(sessionId, modelId, configId, authority) {
		const connection = this.getConnection();
		return normalizeConfigOptionAcknowledgement(await this.runConnectionRequest(() => connection.agent.request(methods.agent.session.setConfigOption, {
			sessionId,
			configId,
			value: modelId
		}), authority, (error) => this.throwSessionModelError("session/set_config_option", modelId, error)));
	}
	async setSessionModelThroughLegacyMethod(sessionId, modelId, authority) {
		const connection = this.getConnection();
		await this.runConnectionRequest(() => connection.agent.request("session/set_model", {
			sessionId,
			modelId
		}), authority, (error) => this.throwSessionModelError("session/set_model", modelId, error));
	}
	throwSessionModelError(method, modelId, error) {
		const wrapped = maybeWrapSessionControlError(method, error, `for model "${modelId}"`);
		if (wrapped !== error) throw wrapped;
		const acp = extractAcpError(error);
		const summary = acp ? formatSessionControlAcpSummary(acp) : error instanceof Error ? error.message : String(error);
		throw new Error(`Failed ${method} for model "${modelId}": ${summary}`, { cause: error });
	}
	async cancel(sessionId) {
		const connection = this.getConnection();
		const owners = this.pendingPromptOwners.filter((owner) => owner.sessionId === sessionId);
		const active = owners.at(-1);
		const cancellation = active?.cancelPromise ?? this.runConnectionRequest(() => connection.agent.notify(methods.agent.session.cancel, { sessionId })).catch((error) => {
			if (active?.cancelPromise === cancellation) active.cancelPromise = void 0;
			throw error;
		});
		const permissionController = this.takePermissionAbortController(sessionId);
		if (active) {
			active.cancelPromise = cancellation;
			this.cancellingSessionIds.add(sessionId);
		} else this.cancellingSessionIds.delete(sessionId);
		for (const owner of owners) {
			owner.elicitationController.abort();
			owner.requestController.abort();
		}
		permissionController?.abort();
		await cancellation;
	}
	async closeSession(sessionId) {
		const connection = this.getConnection();
		this.cancellingSessionIds.add(sessionId);
		this.abortSessionRequests(sessionId);
		await this.runConnectionRequest(() => connection.agent.request(methods.agent.session.close, { sessionId }));
		if (this.loadedSessionId === sessionId) this.loadedSessionId = void 0;
	}
	async listSessions(params = {}) {
		const connection = this.getConnection();
		return await this.runConnectionRequest(() => connection.agent.request(methods.agent.session.list, params));
	}
	async requestCancelActivePrompt() {
		const active = this.activePrompt;
		if (!active) return false;
		await this.cancel(active.sessionId);
		return true;
	}
	async cancelActivePrompt(waitMs = 2500) {
		const active = this.activePrompt;
		if (!active) return;
		try {
			await this.cancel(active.sessionId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.log(`failed to send session/cancel: ${message}`);
		}
		if (waitMs <= 0) return;
		const activePromise = active.promise;
		if (!activePromise) return;
		let timer;
		const timeoutPromise = new Promise((resolve) => {
			timer = setTimeout(resolve, waitMs);
		});
		try {
			return await Promise.race([activePromise.then((response) => response, () => void 0), timeoutPromise]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	close() {
		this.closing = true;
		this.closeEpoch += 1;
		if (this.closeTask) return this.closeTask;
		this.closeTask = Promise.resolve().then(() => this.finishClose()).finally(() => {
			this.closeTask = void 0;
		});
		return this.closeTask;
	}
	async finishClose() {
		const permissionControllers = [...this.permissionAbortControllers.values()];
		this.permissionAbortControllers.clear();
		const owners = [...this.pendingPromptOwners];
		this.abortActiveElicitation();
		for (const owner of owners) owner.requestController.abort();
		for (const controller of permissionControllers) controller.abort();
		await this.retireNativeResources();
		this.sessionUpdateChain = Promise.resolve();
		this.observedSessionUpdates = 0;
		this.processedSessionUpdates = 0;
		this.suppressSessionUpdates = false;
		this.suppressReplaySessionUpdateMessages = false;
		this.activePrompt = void 0;
		this.pendingPromptOwners.length = 0;
		this.cancellingSessionIds.clear();
		for (const controller of this.permissionAbortControllers.values()) controller.abort();
		this.permissionAbortControllers.clear();
		this.promptPermissionFailures.clear();
		this.loadedSessionId = void 0;
		this.initResult = void 0;
		this.connection = void 0;
		this.agent = void 0;
	}
	async retireNativeResources() {
		const owned = [...this.commandProbes, ...this.agent ? [this.agent] : []];
		const failures = [];
		try {
			await this.terminalManager.shutdown();
		} catch (error) {
			failures.push(error);
		}
		const retired = await Promise.allSettled(owned.map((child) => this.terminateAgentProcess(child)));
		for (const result of retired) if (result.status === "rejected") failures.push(result.reason);
		try {
			this.closeConnection();
		} finally {
			this.rejectPendingConnectionRequests(this.lastAgentExit ? new AgentDisconnectedError(this.lastAgentExit.reason, this.lastAgentExit.exitCode, this.lastAgentExit.signal, { outputAlreadyEmitted: Boolean(this.activePrompt) }) : new AgentDisconnectedError("connection_close", null, null, { outputAlreadyEmitted: Boolean(this.activePrompt) }));
		}
		if (failures.length > 0) throw new AggregateError(failures, "ACP client cleanup failed", { cause: failures[0] });
	}
	async stopIfClosedDuringLaunch(epoch, child, startupFailure, authority) {
		if (this.closeEpoch === epoch) return;
		startupFailure.dispose();
		await this.terminateAgentProcess(child);
		assertControlAuthority(authority);
		throw new Error("ACP client was closed while the agent was starting");
	}
	abortActiveElicitation() {
		this.activePrompt?.elicitationController?.abort();
	}
	closeConnection() {
		this.connection?.close();
	}
	async captureAgentDescendants(child) {
		const descendants = child && this.agentDescendants.get(child);
		if (descendants && !await descendants.capture()) this.log("could not verify agent descendants; skipping unverified process cleanup");
	}
	terminateAgentProcess(child) {
		if (child.pid === void 0) {
			this.agentDescendants.get(child)?.retire();
			this.detachAgentHandles(child, true);
			return Promise.resolve();
		}
		let cleanup = this.agentCleanups.get(child);
		if (!cleanup) {
			cleanup = Promise.resolve().then(() => this.cleanupAgentProcess(child));
			this.agentCleanups.set(child, cleanup);
		}
		return cleanup;
	}
	async cleanupAgentProcess(child) {
		const descendants = this.agentDescendants.get(child);
		const deadline = performance.now() + AGENT_CLEANUP_BUDGET_MS;
		const stdinCloseGraceMs = resolveAgentCloseAfterStdinEndMs(this.options.agentCommand);
		try {
			if (descendants) await descendants.capture(Math.max(1, deadline - performance.now()));
			this.endAgentStdin(child);
			await waitForChildExit(child, Math.min(stdinCloseGraceMs, Math.max(0, deadline - performance.now())));
			if (!await this.signalAgentAndDescendants(child, "SIGTERM", AGENT_CLOSE_TERM_GRACE_MS, deadline)) {
				this.log("agent processes did not exit after SIGTERM; forcing SIGKILL");
				await this.signalAgentAndDescendants(child, "SIGKILL", AGENT_CLOSE_KILL_GRACE_MS, deadline);
			}
		} finally {
			descendants?.retire();
			this.detachAgentHandles(child, isChildProcessRunning(child));
		}
	}
	endAgentStdin(child) {
		if (!child.stdin || child.stdin.destroyed) return;
		try {
			child.stdin.end();
		} catch {}
	}
	async signalAgentAndDescendants(child, signal, waitMs, deadline) {
		const descendants = this.agentDescendants.get(child);
		if (descendants && performance.now() < deadline) await descendants.signal(signal, deadline - performance.now());
		if (isChildProcessRunning(child)) try {
			child.kill(signal);
		} catch {}
		const remaining = Math.min(waitMs, Math.max(0, deadline - performance.now()));
		const [exited, descendantsExited] = await Promise.all([waitForChildExit(child, remaining), descendants ? descendants.waitForExit(remaining) : Promise.resolve(true)]);
		return exited && descendantsExited;
	}
	detachAgentHandles(agent, unref) {
		const stdin = agent.stdin;
		const stdout = agent.stdout;
		const stderr = agent.stderr;
		stdin?.destroy();
		stdout?.destroy();
		stderr?.destroy();
		if (unref) try {
			agent.unref();
		} catch {}
	}
	getConnection() {
		if (!this.connection) throw new Error("ACP client not started");
		return this.connection;
	}
	log(message) {
		if (!this.options.verbose) return;
		process.stderr.write(`[acpx] ${message}\n`);
	}
	captureStartupStderr(target, chunk) {
		const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		if (text.length === 0) return;
		target.push(text);
		if (target.join("").length - STARTUP_STDERR_MAX_CHARS <= 0) return;
		const joined = target.join("");
		target.splice(0, target.length, joined.slice(-8192));
	}
	summarizeStartupStderr(target) {
		const joined = target.join("").trim();
		if (!joined) return;
		return joined.replace(/\s+/gu, " ").trim().slice(0, STARTUP_STDERR_MAX_CHARS);
	}
	createStartupFailureWatcher(child, startupStderr) {
		let settled = false;
		let failure;
		let rejectPromise;
		const cleanup = () => {
			child.off("error", onError);
			child.off("exit", onExit);
			child.off("close", onClose);
		};
		const finish = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) {
				failure = error;
				rejectPromise(error);
			}
		};
		const createError = (params) => new AgentStartupError({
			agentCommand: this.options.agentCommand,
			exitCode: params?.exitCode ?? child.exitCode ?? null,
			signal: params?.signal ?? child.signalCode ?? null,
			stderrSummary: this.summarizeStartupStderr(startupStderr),
			cause: params?.cause
		});
		const onError = (error) => {
			finish(createError({ cause: error }));
		};
		const onExit = (exitCode, signal) => {
			finish(createError({
				exitCode,
				signal
			}));
		};
		const onClose = (exitCode, signal) => {
			finish(createError({
				exitCode,
				signal
			}));
		};
		const promise = new Promise((_resolve, reject) => {
			rejectPromise = reject;
			child.once("error", onError);
			child.once("exit", onExit);
			child.once("close", onClose);
			if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
		});
		promise.catch(() => {});
		return {
			promise,
			dispose: () => finish(),
			getError: () => failure
		};
	}
	async normalizeInitializeError(error, child, startupStderr) {
		if (error instanceof AgentStartupError) return error;
		const connectionClosedDuringInitialize = error instanceof Error && /acp connection closed/i.test(error.message);
		await waitForChildExit(child, 100);
		const childExited = child.exitCode !== null || child.signalCode !== null;
		if (!connectionClosedDuringInitialize && !childExited) return error;
		return new AgentStartupError({
			agentCommand: this.options.agentCommand,
			exitCode: child.exitCode ?? null,
			signal: child.signalCode ?? null,
			stderrSummary: this.summarizeStartupStderr(startupStderr),
			cause: error
		});
	}
	selectAuthMethod(methods) {
		for (const method of methods) {
			const envCredential = readEnvCredential(method.id);
			if (envCredential) return {
				methodId: method.id,
				credential: envCredential,
				source: "env"
			};
			const configCredential = resolveConfiguredAuthCredential(method.id, this.options.authCredentials);
			if (typeof configCredential === "string" && configCredential.trim().length > 0) return {
				methodId: method.id,
				credential: configCredential,
				source: "config"
			};
			const agentSpecificEnvCredential = this.readAgentSpecificEnvCredential(method.id);
			if (agentSpecificEnvCredential) return {
				methodId: method.id,
				credential: agentSpecificEnvCredential,
				source: "env"
			};
		}
		for (const method of methods) {
			const agentManagedSelection = this.selectAgentManagedAuthMethod(method.id);
			if (agentManagedSelection) return agentManagedSelection;
		}
	}
	inheritedEnvPolicy() {
		return {
			allow: this.options.agentProcessEnvAllow,
			block: this.options.agentProcessEnvBlock
		};
	}
	readAgentSpecificEnvCredential(methodId) {
		if (!this.isGrokBuildAcpCommand() || methodId !== "xai.api_key" || !isInheritedEnvName(this.inheritedEnvPolicy(), "XAI_API_KEY")) return;
		const value = process.env.XAI_API_KEY;
		return typeof value === "string" && value.trim().length > 0 ? value : void 0;
	}
	selectAgentManagedAuthMethod(methodId) {
		if (!this.isGrokBuildAcpCommand() || methodId !== "cached_token") return;
		return {
			methodId,
			source: "agent"
		};
	}
	isGrokBuildAcpCommand() {
		const { command, args } = resolveAgentCommandParts(this.options.agentCommand, this.options.agentArgv);
		return command.replace(/\\/g, "/").split("/").pop()?.replace(/\.(cmd|exe|ps1)$/iu, "").toLowerCase() === "grok" && args[0] === "agent" && args[1] === "stdio";
	}
	async authenticateIfRequired(connection, authMethods) {
		if (authMethods.length === 0) return;
		const selected = this.selectAuthMethod(authMethods);
		if (!selected) {
			if (this.options.authPolicy === "fail") throw new AuthPolicyError(`agent advertised auth methods [${authMethods.map((m) => m.id).join(", ")}] but no matching credentials found`);
			this.log(`agent advertised auth methods [${authMethods.map((m) => m.id).join(", ")}] but no matching credentials found — skipping (agent may handle auth internally)`);
			return;
		}
		await connection.agent.request(methods.agent.authenticate, { methodId: selected.methodId });
		this.log(`authenticated with method ${selected.methodId} (${selected.source})`);
	}
	async handlePermissionRequest(params, requestSignal) {
		const owner = this.captureDelegatedRequestOwner(params.sessionId, requestSignal);
		if (!this.isDelegatedRequestActive(owner)) return cancelledPermissionResponse();
		if (!this.hasPermissionOwner(params.sessionId)) return this.finishPermissionRequest(params, owner, cancelledPermissionResponse());
		if (this.initResult?.agentInfo?.name === "antigravity-acp" && params.toolCall.toolCallId.startsWith("interaction_")) {
			const response = this.handleModePermissionError(params.sessionId, new PermissionPromptUnavailableError("Antigravity requested a user answer. acpx cannot answer Antigravity interaction questions; continue in an interactive client."));
			return this.finishPermissionRequest(params, owner, response);
		}
		const response = await this.tryHandlePermissionRequestWithHost(params, owner) ?? await this.resolvePermissionRequestFromMode(params, owner);
		return this.finishPermissionRequest(params, owner, response);
	}
	finishPermissionRequest(params, owner, response) {
		const result = this.isDelegatedRequestActive(owner) ? response : cancelledPermissionResponse();
		this.recordPermissionDecision(classifyPermissionDecision(params, result));
		return result;
	}
	hasPermissionOwner(sessionId) {
		return !this.pendingPromptOwners.some((owner) => owner.permissionHandler !== void 0) || this.pendingPromptOwners.some((owner) => owner.sessionId === sessionId);
	}
	async handleElicitationRequest(request, requestId, requestSignal) {
		const resolved = this.resolveElicitationOwner(request);
		if ("response" in resolved) return resolved.response;
		const { active, handler } = resolved.owner;
		const signal = AbortSignal.any([
			requestSignal,
			active.elicitationController.signal,
			active.authority?.signal
		].filter((candidate) => candidate !== void 0));
		const outcome = await raceWithAbort(signal, Promise.resolve().then(async () => {
			signal.throwIfAborted();
			return await handler(request, {
				requestId,
				signal
			});
		}).then((response) => ({
			kind: "response",
			response
		}), (error) => ({
			kind: "error",
			error
		})));
		if (this.activePrompt !== active) return cancelledElicitationResponse(ELICITATION_CANCEL_MESSAGES.inactive);
		if (!outcome || signal.aborted) return cancelledElicitationResponse(ELICITATION_CANCEL_MESSAGES.cancelled);
		if (outcome.kind === "error" || !isKnownElicitationResponse(outcome.response)) return cancelledElicitationResponse(ELICITATION_CANCEL_MESSAGES.unavailable);
		return outcome.response;
	}
	resolveElicitationOwner(request) {
		if (!this.options.elicitationModes?.includes(request.mode)) return { response: cancelledElicitationResponse(ELICITATION_CANCEL_MESSAGES.unsupported) };
		const active = this.activePrompt;
		if (!active) return { response: cancelledElicitationResponse(ELICITATION_CANCEL_MESSAGES.inactive) };
		const scope = this.resolveElicitationScope(request, active);
		if ("response" in scope) return scope;
		if (this.isElicitationSessionCancelling(scope.sessionId)) return { response: cancelledElicitationResponse(ELICITATION_CANCEL_MESSAGES.cancelled) };
		if (!active.elicitationHandler) return { response: cancelledElicitationResponse(ELICITATION_CANCEL_MESSAGES.unavailable) };
		return { owner: {
			active,
			handler: active.elicitationHandler
		} };
	}
	resolveElicitationScope(request, active) {
		const sessionId = elicitationSessionId(request);
		if (sessionId) return sessionId === active.sessionId ? { sessionId } : { response: cancelledElicitationResponse(ELICITATION_CANCEL_MESSAGES.mismatchedSession) };
		const requestScopeId = elicitationRequestScopeId(request);
		if (requestScopeId === void 0 || requestScopeId !== active.requestId) return { response: cancelledElicitationResponse(ELICITATION_CANCEL_MESSAGES.requestScoped) };
		return { sessionId: active.sessionId };
	}
	isElicitationSessionCancelling(sessionId) {
		return this.closing || this.cancellingSessionIds.has(sessionId);
	}
	captureDelegatedRequestOwner(sessionId, requestSignal) {
		const active = this.pendingPromptOwners.findLast((owner) => owner.sessionId === sessionId);
		const signal = AbortSignal.any([
			active?.requestController.signal ?? this.cancellationSignalForSession(sessionId),
			active?.authority?.signal,
			requestSignal
		].filter((candidate) => candidate !== void 0));
		const epoch = this.closeEpoch;
		return {
			signal,
			permissionHandler: active?.permissionHandler ?? this.options.onPermissionRequest,
			assertActive: () => {
				if (this.closing || this.closeEpoch !== epoch || this.cancellingSessionIds.has(sessionId)) throw RequestError.requestCancelled();
			}
		};
	}
	isDelegatedRequestActive(owner) {
		try {
			assertControlAuthority(owner);
			return true;
		} catch {
			return false;
		}
	}
	async tryHandlePermissionRequestWithHost(params, owner) {
		const handler = owner.permissionHandler;
		if (!handler) return;
		const { signal } = owner;
		if (!this.isDelegatedRequestActive(owner)) return cancelledPermissionResponse();
		try {
			const decision = await raceWithAbort(signal, handler({
				sessionId: params.sessionId,
				raw: params,
				inferredKind: inferToolKind(params)
			}, { signal }));
			return this.hostPermissionDecisionResponse(params, owner, decision);
		} catch (error) {
			return this.hostPermissionErrorResponse(owner, error);
		}
	}
	hostPermissionDecisionResponse(params, owner, decision) {
		if (!this.isDelegatedRequestActive(owner)) return cancelledPermissionResponse();
		if (!decision) return;
		const response = decisionToResponse(preferCodexPermissionRefusal(params, this.initResult?.agentInfo?.name), decision);
		return decision.outcome === "cancel" ? response : this.explainPermissionRefusal(params, response);
	}
	hostPermissionErrorResponse(owner, error) {
		if (!this.isDelegatedRequestActive(owner)) return cancelledPermissionResponse();
		this.log(`onPermissionRequest threw, falling through to mode-based resolver: ${error instanceof Error ? error.message : String(error)}`);
	}
	async resolvePermissionRequestFromMode(params, owner) {
		try {
			assertControlAuthority(owner);
			const result = await resolvePermissionRequestWithDetails(preferCodexPermissionRefusal(params, this.initResult?.agentInfo?.name), this.options.permissionMode, this.options.nonInteractivePermissions ?? "deny", this.options.permissionPolicy, owner.signal);
			assertControlAuthority(owner);
			this.emitPermissionEscalation(result.escalation);
			return this.explainPermissionRefusal(params, result.response);
		} catch (error) {
			if (!this.isDelegatedRequestActive(owner)) return cancelledPermissionResponse();
			return this.handleModePermissionError(params.sessionId, error);
		}
	}
	explainPermissionRefusal(params, response) {
		const notice = codexPermissionNotice(params, response, this.initResult?.agentInfo?.name);
		if (!notice || this.cancellingSessionIds.has(params.sessionId)) return response;
		try {
			this.eventHandlers.onClientOperation?.({
				method: "session/request_permission",
				status: "completed",
				summary: notice,
				timestamp: isoNow$2()
			});
		} catch {}
		return withPermissionMetadata(response, { permissionNotice: notice });
	}
	emitPermissionEscalation(escalation) {
		if (escalation) this.eventHandlers.onPermissionEscalation?.(escalation);
	}
	handleModePermissionError(sessionId, error) {
		if (!(error instanceof PermissionPromptUnavailableError)) throw error;
		this.notePromptPermissionFailure(sessionId, error);
		return cancelledPermissionResponse();
	}
	attachAgentLifecycleObservers(child, startedProcess, exitNotificationBarrier) {
		this.attachProcessExitObserver(child, startedProcess, exitNotificationBarrier, (exitCode, signal) => {
			this.handleAgentDisconnect(child, "process_exit", exitCode, signal);
			this.terminateAgentProcess(child);
		});
		child.once("close", (exitCode, signal) => {
			this.handleAgentDisconnect(child, "process_close", exitCode, signal);
		});
		child.stdout.once("close", () => {
			this.handleAgentDisconnect(child, "pipe_close", child.exitCode ?? null, child.signalCode ?? null);
		});
	}
	attachProcessExitObserver(child, started, barrier, onProcessExit) {
		const onExit = (exitCode, signal) => {
			const exitedAt = isoNow$2();
			onProcessExit?.(exitCode, signal);
			barrier.then(() => this.notifyProcessExit(started, exitCode, signal, exitedAt));
		};
		child.once("exit", onExit);
		if (child.exitCode !== null || child.signalCode !== null) {
			child.off("exit", onExit);
			onExit(child.exitCode, child.signalCode);
		}
	}
	handleAgentDisconnect(child, reason, exitCode, signal) {
		this.recordAgentExit(child, reason, exitCode, signal);
		if (this.agent !== child || this.closing || !this.connection) return;
		this.close().catch((error) => {
			this.log(`disconnected agent cleanup failed: ${String(error)}`);
		});
	}
	notifyProcessSpawnFailure(launch, error) {
		const handler = this.options.processLifecycle?.onSpawnFailed;
		if (!handler) return;
		const event = Object.freeze({
			...launch,
			error,
			failedAt: isoNow$2()
		});
		try {
			Promise.resolve(handler(event)).catch((observerError) => {
				this.logProcessLifecycleError("onSpawnFailed", observerError);
			});
		} catch (observerError) {
			this.logProcessLifecycleError("onSpawnFailed", observerError);
		}
	}
	notifyProcessExit(startedProcess, exitCode, signal, exitedAt) {
		const handler = this.options.processLifecycle?.onExit;
		if (!handler) return;
		const event = Object.freeze({
			...startedProcess,
			exitCode,
			signal,
			exitedAt
		});
		try {
			Promise.resolve(handler(event)).catch((error) => {
				this.logProcessLifecycleError("onExit", error);
			});
		} catch (error) {
			this.logProcessLifecycleError("onExit", error);
		}
	}
	logProcessLifecycleError(hook, error) {
		const message = error instanceof Error ? error.message : String(error);
		this.log(`process lifecycle ${hook} hook failed: ${message}`);
	}
	recordAgentExit(child, reason, exitCode, signal) {
		if (this.agent !== child || this.lastAgentExit) return;
		this.lastAgentExit = {
			exitCode,
			signal,
			exitedAt: isoNow$2(),
			reason,
			unexpectedDuringPrompt: !this.closing && Boolean(this.activePrompt)
		};
		this.rejectPendingConnectionRequests(new AgentDisconnectedError(reason, exitCode, signal, { outputAlreadyEmitted: Boolean(this.activePrompt) }));
	}
	notePromptPermissionFailure(sessionId, error) {
		if (!this.promptPermissionFailures.has(sessionId)) this.promptPermissionFailures.set(sessionId, error);
	}
	consumePromptPermissionFailure(sessionId) {
		const error = this.promptPermissionFailures.get(sessionId);
		if (error) this.promptPermissionFailures.delete(sessionId);
		return error;
	}
	async runConnectionRequest(run, authority, mapRequestError) {
		return await new Promise((resolve, reject) => {
			const rejectRequestError = (error) => {
				try {
					reject(mapRequestError ? mapRequestError(error) : error);
				} catch (mappedError) {
					reject(mappedError);
				}
			};
			const pending = {
				settled: false,
				reject: rejectRequestError
			};
			const finish = (cb) => {
				if (pending.settled) return;
				pending.settled = true;
				this.pendingConnectionRequests.delete(pending);
				cb();
			};
			this.pendingConnectionRequests.add(pending);
			Promise.resolve().then(async () => {
				if (pending.settled) return { started: false };
				try {
					assertControlAuthority(authority);
				} catch (error) {
					finish(() => reject(error));
					return { started: false };
				}
				return {
					started: true,
					value: await run()
				};
			}).then((outcome) => {
				if (outcome.started) finish(() => resolve(outcome.value));
			}, (error) => finish(() => rejectRequestError(error)));
		});
	}
	rejectPendingConnectionRequests(error) {
		for (const pending of this.pendingConnectionRequests) {
			if (pending.settled) {
				this.pendingConnectionRequests.delete(pending);
				continue;
			}
			pending.settled = true;
			this.pendingConnectionRequests.delete(pending);
			pending.reject(error);
		}
	}
	async handleReadTextFile(params, requestSignal) {
		try {
			return await this.runDelegatedOperation(params.sessionId, requestSignal, (owner) => this.filesystem.readTextFile(params, owner));
		} catch (error) {
			if (error instanceof FsSafeError && error.code === "not-found" || error instanceof Error && "code" in error && error.code === "ENOENT") throw RequestError.resourceNotFound(pathToFileURL(params.path).href);
			throw error;
		}
	}
	async handleWriteTextFile(params, requestSignal) {
		return await this.runDelegatedOperation(params.sessionId, requestSignal, (owner) => this.filesystem.writeTextFile(params, owner));
	}
	async handleCreateTerminal(params, requestSignal) {
		return await this.runDelegatedOperation(params.sessionId, requestSignal, (owner) => this.terminalManager.createTerminal(params, owner));
	}
	async runDelegatedOperation(sessionId, requestSignal, run) {
		const owner = this.captureDelegatedRequestOwner(sessionId, requestSignal);
		try {
			assertControlAuthority(owner);
			const result = await run(owner);
			assertControlAuthority(owner);
			return result;
		} catch (error) {
			if (!this.isDelegatedRequestActive(owner)) throw RequestError.requestCancelled();
			this.recordPermissionError(sessionId, error);
			throw error;
		}
	}
	cancellationSignalForSession(sessionId) {
		let controller = this.permissionAbortControllers.get(sessionId);
		if (!controller) {
			controller = new AbortController();
			this.permissionAbortControllers.set(sessionId, controller);
		}
		return controller.signal;
	}
	takePermissionAbortController(sessionId) {
		const controller = this.permissionAbortControllers.get(sessionId);
		this.permissionAbortControllers.delete(sessionId);
		return controller;
	}
	recordPermissionDecision(decision) {
		this.permissionStats.requested += 1;
		if (decision === "approved") {
			this.permissionStats.approved += 1;
			return;
		}
		if (decision === "denied") {
			this.permissionStats.denied += 1;
			return;
		}
		this.permissionStats.cancelled += 1;
	}
	recordPermissionError(sessionId, error) {
		if (error instanceof PermissionPromptUnavailableError) {
			this.notePromptPermissionFailure(sessionId, error);
			this.recordPermissionDecision("cancelled");
			return;
		}
		if (error instanceof PermissionDeniedError) this.recordPermissionDecision("denied");
	}
	async handleSessionUpdate(notification) {
		const sequence = ++this.observedSessionUpdates;
		this.sessionUpdateChain = this.sessionUpdateChain.then(async () => {
			try {
				if (!this.suppressSessionUpdates) this.eventHandlers.onSessionUpdate?.(notification);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.log(`session update handler failed: ${message}`);
			} finally {
				this.processedSessionUpdates = sequence;
			}
		});
		await this.sessionUpdateChain;
	}
	async waitForSessionUpdateDrain(idleMs, timeoutMs) {
		const normalizedIdleMs = Math.max(0, idleMs);
		const normalizedTimeoutMs = Math.max(normalizedIdleMs, timeoutMs);
		const deadline = Date.now() + normalizedTimeoutMs;
		let lastObserved = this.observedSessionUpdates;
		let idleSince = Date.now();
		while (Date.now() <= deadline) {
			const observed = this.observedSessionUpdates;
			if (observed !== lastObserved) {
				lastObserved = observed;
				idleSince = Date.now();
			}
			if (this.processedSessionUpdates === this.observedSessionUpdates && Date.now() - idleSince >= normalizedIdleMs) {
				await this.sessionUpdateChain;
				if (this.processedSessionUpdates === this.observedSessionUpdates) return;
			}
			await new Promise((resolve) => {
				setTimeout(resolve, DRAIN_POLL_INTERVAL_MS);
			});
		}
		throw new Error(`Timed out waiting for session replay drain after ${normalizedTimeoutMs}ms`);
	}
	async waitForSessionUpdatesIdle(options) {
		await this.waitForSessionUpdateDrain(options?.idleMs ?? 0, options?.timeoutMs ?? 0);
	}
};
// src/session/model-state.ts
function configOptionsAreAuthoritative(state) {
	return state.model_control === "config_option";
}
function legacyModelState(state) {
	if (!Array.isArray(state.available_models)) return;
	return {
		currentModelId: state.current_model_id ?? "",
		availableModels: state.available_models.map((modelId) => ({
			modelId,
			name: state.available_model_names && Object.hasOwn(state.available_model_names, modelId) ? state.available_model_names[modelId] : modelId
		}))
	};
}
function advertisedModelState(state) {
	if (!state) return;
	const configModels = modelStateFromConfigOptions(state?.config_options);
	if (configModels) return configModels;
	if (configOptionsAreAuthoritative(state)) return;
	return legacyModelState(state);
}
function applyAdvertisedModelState(state, models) {
	state.current_model_id = models.currentModelId;
	state.available_models = models.availableModels.map((model) => model.modelId);
	state.available_model_names = Object.fromEntries(models.availableModels.map((model) => [model.modelId, model.name]));
	state.model_control = models.configId ? "config_option" : "legacy_set_model";
}
function clearAdvertisedModelState(state) {
	delete state.current_model_id;
	delete state.available_models;
	delete state.available_model_names;
	delete state.model_control;
}
function removeModelConfigOptions(state) {
	if (!state.config_options) return;
	state.config_options = state.config_options.filter((option) => option.category !== "model" && option.id !== "model");
}
function applyConfigOptionsModelState(state, configOptions) {
	if (!Array.isArray(configOptions)) return;
	const previousConfigModels = modelStateFromConfigOptions(state.config_options);
	const preservesLegacyControl = state.model_control === "legacy_set_model" || state.model_control === void 0 && previousConfigModels === void 0 && legacyModelState(state) !== void 0;
	state.config_options = structuredClone(configOptions);
	const models = modelStateFromConfigOptions(configOptions);
	if (models) applyAdvertisedModelState(state, models);
	else if (preservesLegacyControl) state.model_control = "legacy_set_model";
	else clearAdvertisedModelState(state);
}
// src/session/conversation-reducer.ts
function resolveUserMessageId(value) {
	return typeof value === "string" ? value : value();
}
function deepClone(value) {
	try {
		return structuredClone(value);
	} catch {
		return value;
	}
}
function hasOwn(source, key) {
	return Object.prototype.hasOwnProperty.call(source, key);
}
function normalizeAgentName(value) {
	return trimmedString(value);
}
function trimmedString(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function normalizeAvailableCommand(value) {
	const record = asRecord(value);
	if (!record) return;
	const name = trimmedString(record.name);
	if (!name) return;
	const description = trimmedString(record.description);
	return {
		name,
		...description ? { description } : {},
		has_input: record.input != null
	};
}
function extractText(content) {
	switch (content.type) {
		case "text": return content.text;
		case "resource_link": return content.title ?? content.name ?? content.uri;
		case "resource": return extractResourceText(content);
		case "audio": return `[audio] ${content.mimeType}`;
		default: return;
	}
}
function extractResourceText(content) {
	return "text" in content.resource && typeof content.resource.text === "string" ? content.resource.text : content.resource.uri;
}
function contentToUserContent(content) {
	if (content.type === "text") return { Text: content.text };
	if (content.type === "resource_link") {
		const value = content.title ?? content.name ?? content.uri;
		return { Mention: {
			uri: content.uri,
			content: value
		} };
	}
	if (content.type === "resource") return resourceToUserContent(content);
	if (content.type === "image") return { Image: {
		source: content.data,
		mime_type: content.mimeType,
		size: null
	} };
	if (content.type === "audio") return { Audio: {
		source: content.data,
		mime_type: content.mimeType
	} };
}
function resourceToUserContent(content) {
	if ("text" in content.resource && typeof content.resource.text === "string") return { Text: content.resource.text };
	return { Mention: {
		uri: content.resource.uri,
		content: content.resource.uri
	} };
}
function isUserMessage(message) {
	return typeof message === "object" && message !== null && hasOwn(message, "User");
}
function isAgentMessage(message) {
	return typeof message === "object" && message !== null && hasOwn(message, "Agent");
}
function isAgentTextContent(content) {
	return hasOwn(content, "Text");
}
function isAgentThinkingContent(content) {
	return hasOwn(content, "Thinking");
}
function isAgentToolUseContent(content) {
	return hasOwn(content, "ToolUse");
}
function updateConversationTimestamp(conversation, timestamp) {
	conversation.updated_at = timestamp;
}
function ensureAgentMessage(conversation) {
	const last = conversation.messages.at(-1);
	if (last && isAgentMessage(last)) return last.Agent;
	const created = {
		content: [],
		tool_results: {}
	};
	conversation.messages.push({ Agent: created });
	return created;
}
function appendAgentText(agent, text) {
	const last = agent.content.at(-1);
	if (last && isAgentTextContent(last)) {
		last.Text = `${last.Text}${text}`;
		return;
	}
	const next = { Text: text };
	agent.content.push(next);
}
function appendAgentThinking(agent, text) {
	const last = agent.content.at(-1);
	if (last && isAgentThinkingContent(last)) {
		last.Thinking.text = `${last.Thinking.text}${text}`;
		return;
	}
	const next = { Thinking: {
		text,
		signature: null
	} };
	agent.content.push(next);
}
function statusIndicatesComplete(status) {
	if (typeof status !== "string") return false;
	const normalized = status.toLowerCase();
	return normalized.includes("complete") || normalized.includes("done") || normalized.includes("success") || normalized.includes("failed") || normalized.includes("error") || normalized.includes("cancel");
}
function statusIndicatesError(status) {
	if (typeof status !== "string") return false;
	const normalized = status.toLowerCase();
	return normalized.includes("fail") || normalized.includes("error");
}
function toToolResultContent(value) {
	if (typeof value === "string") return { Text: value };
	if (value != null) try {
		return { Text: JSON.stringify(value) ?? "[Unserializable value]" };
	} catch {
		return { Text: "[Unserializable value]" };
	}
	return { Text: "" };
}
function toRawInput(value) {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value ?? {}) ?? "[Unserializable input]";
	} catch {
		return value == null ? "" : "[Unserializable input]";
	}
}
function ensureToolUseContent(agent, toolCallId) {
	for (const content of agent.content) if (isAgentToolUseContent(content) && content.ToolUse.id === toolCallId) return content.ToolUse;
	const created = {
		id: toolCallId,
		name: "tool_call",
		raw_input: "{}",
		input: {},
		is_input_complete: false,
		thought_signature: null
	};
	agent.content.push({ ToolUse: created });
	return created;
}
function upsertToolResult(agent, toolCallId, patch) {
	const fallback = existingToolResultValues(hasOwn(agent.tool_results, toolCallId) ? agent.tool_results[toolCallId] : void 0);
	const next = {
		tool_use_id: toolCallId,
		tool_name: patch.tool_name ?? fallback.tool_name,
		is_error: patch.is_error ?? fallback.is_error,
		content: patch.content ?? fallback.content,
		output: patch.output ?? fallback.output
	};
	Object.defineProperty(agent.tool_results, toolCallId, {
		value: next,
		writable: true,
		enumerable: true,
		configurable: true
	});
}
function existingToolResultValues(existing) {
	if (existing) return existing;
	return {
		tool_use_id: "",
		tool_name: "tool_call",
		is_error: false,
		content: { Text: "" },
		output: void 0
	};
}
function applyToolCallUpdate(agent, update) {
	const contentCount = agent.content.length;
	const tool = ensureToolUseContent(agent, update.toolCallId);
	applyToolIdentityUpdate(tool, update);
	applyToolInputUpdate(tool, update);
	applyToolStatusUpdate(tool, update);
	applyToolResultUpdate(agent, tool, update);
	return agent.content.length !== contentCount || hasOwn(update, "rawInput") || hasToolResultPatch(update);
}
function applyToolIdentityUpdate(tool, update) {
	if (hasOwn(update, "title")) tool.name = normalizeAgentName(update.title) ?? tool.name ?? "tool_call";
	if (hasOwn(update, "kind")) {
		const kindName = normalizeAgentName(update.kind);
		if (!tool.name || tool.name === "tool_call") tool.name = kindName ?? tool.name;
	}
}
function applyToolInputUpdate(tool, update) {
	if (!hasOwn(update, "rawInput")) return;
	const rawInput = deepClone(update.rawInput);
	tool.input = rawInput ?? {};
	tool.raw_input = toRawInput(rawInput);
}
function applyToolStatusUpdate(tool, update) {
	if (hasOwn(update, "status")) tool.is_input_complete = statusIndicatesComplete(update.status);
}
function applyToolResultUpdate(agent, tool, update) {
	if (!hasToolResultPatch(update)) return;
	const status = update.status;
	const output = hasOwn(update, "rawOutput") ? deepClone(update.rawOutput) : void 0;
	upsertToolResult(agent, update.toolCallId, {
		tool_name: tool.name,
		is_error: status === void 0 ? void 0 : statusIndicatesError(status),
		content: output === void 0 ? void 0 : toToolResultContent(output),
		output
	});
}
function hasToolResultPatch(update) {
	return [
		"rawOutput",
		"status",
		"title",
		"kind"
	].some((key) => hasOwn(update, key));
}
function asRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value;
}
function numberField(source, keys) {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	}
}
function sourceToTokenUsage(source) {
	const usageRecord = asRecord(source);
	if (!usageRecord) return;
	const normalized = {
		input_tokens: numberField(usageRecord, ["input_tokens", "inputTokens"]),
		output_tokens: numberField(usageRecord, ["output_tokens", "outputTokens"]),
		cache_creation_input_tokens: numberField(usageRecord, [
			"cache_creation_input_tokens",
			"cacheCreationInputTokens",
			"cachedWriteTokens"
		]),
		cache_read_input_tokens: numberField(usageRecord, [
			"cache_read_input_tokens",
			"cacheReadInputTokens",
			"cachedReadTokens"
		]),
		thought_tokens: numberField(usageRecord, ["thought_tokens", "thoughtTokens"]),
		total_tokens: numberField(usageRecord, ["total_tokens", "totalTokens"])
	};
	if (!hasTokenUsageValue(normalized)) return;
	return normalized;
}
function usageToTokenUsage(update) {
	const updateRecord = asRecord(update);
	const usageMeta = asRecord(updateRecord?._meta)?.usage;
	const source = asRecord(usageMeta) ?? updateRecord;
	if (!source) return;
	return sourceToTokenUsage(source);
}
function hasTokenUsageValue(usage) {
	return Object.values(usage).some((value) => value !== void 0);
}
function usageCost(update) {
	const cost = asRecord(asRecord(update)?.cost);
	if (!cost) return;
	return buildUsageCost(numberField(cost, ["amount"]), stringField(cost.currency));
}
function stringField(value) {
	return typeof value === "string" && value.trim() ? value : void 0;
}
function buildUsageCost(amount, currency) {
	const cost = {
		...amount !== void 0 ? { amount } : {},
		...currency !== void 0 ? { currency } : {}
	};
	return Object.keys(cost).length > 0 ? cost : void 0;
}
function ensureAcpxState$1(state) {
	return state ?? {};
}
function lastUserMessageId(conversation) {
	for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
		const message = conversation.messages[index];
		if (message && isUserMessage(message)) return message.User.id;
	}
}
function createConversation(timestamp) {
	return {
		title: null,
		messages: [],
		updated_at: timestamp,
		cumulative_token_usage: {},
		cumulative_cost: void 0,
		request_token_usage: {}
	};
}
function cloneConversation(conversation) {
	return {
		title: conversation.title,
		messages: deepClone(conversation.messages ?? []),
		updated_at: conversation.updated_at,
		cumulative_token_usage: deepClone(conversation.cumulative_token_usage ?? {}),
		cumulative_cost: cloneUsageCost(conversation.cumulative_cost),
		request_token_usage: deepClone(conversation.request_token_usage ?? {})
	};
}
function cloneUsageCost(cost) {
	return cost ? { ...cost } : void 0;
}
function cloneSessionAcpxState(state) {
	if (!state) return;
	return {
		...state.session_origin ? { session_origin: state.session_origin } : {},
		current_mode_id: state.current_mode_id,
		desired_mode_id: state.desired_mode_id,
		desired_config_options: state.desired_config_options ? { ...state.desired_config_options } : void 0,
		current_model_id: state.current_model_id,
		available_models: state.available_models ? [...state.available_models] : void 0,
		...state.available_model_names ? { available_model_names: { ...state.available_model_names } } : {},
		model_control: state.model_control,
		available_commands: state.available_commands ? state.available_commands.map((command) => ({ ...command })) : void 0,
		config_options: state.config_options ? deepClone(state.config_options) : void 0,
		session_options: cloneSessionOptions(state.session_options)
	};
}
function cloneSessionOptions(options) {
	if (!options) return;
	return {
		model: options.model,
		allowed_tools: options.allowed_tools ? [...options.allowed_tools] : void 0,
		max_turns: options.max_turns,
		...options.system_prompt !== void 0 ? { system_prompt: cloneSystemPromptOption(options.system_prompt) } : {},
		...options.env !== void 0 ? { env: { ...options.env } } : {}
	};
}
function cloneSystemPromptOption(option) {
	return typeof option === "string" ? option : { append: option.append };
}
function reducePromptSubmission(conversation, prompt, timestamp, messageId) {
	const userContent = (typeof prompt === "string" ? textPrompt(prompt) : prompt).map((content) => contentToUserContent(content)).filter((content) => content !== void 0);
	if (userContent.length === 0) return { messageIndex: void 0 };
	conversation.messages.push({ User: {
		id: resolveUserMessageId(messageId),
		content: userContent
	} });
	updateConversationTimestamp(conversation, timestamp);
	return { messageIndex: conversation.messages.length - 1 };
}
function reduceSessionUpdate(conversation, state, notification, timestamp, userMessageId) {
	const acpx = ensureAcpxState$1(state);
	const messageIndex = applySessionUpdate(conversation, acpx, notification.update, userMessageId);
	updateConversationTimestamp(conversation, timestamp);
	return {
		acpx,
		messageIndex
	};
}
function reducePromptResponseUsage(conversation, usage, promptMessageId, timestamp) {
	const tokenUsage = sourceToTokenUsage(usage);
	if (!tokenUsage) return false;
	applyTokenUsage(conversation, tokenUsage, promptMessageId);
	updateConversationTimestamp(conversation, timestamp);
	return true;
}
function applySessionUpdate(conversation, acpx, update, userMessageId) {
	return (Object.hasOwn(SESSION_UPDATE_HANDLERS, update.sessionUpdate) ? SESSION_UPDATE_HANDLERS[update.sessionUpdate] : void 0)?.(conversation, acpx, update, userMessageId);
}
const SESSION_UPDATE_HANDLERS = {
	user_message_chunk: (conversation, _acpx, update, userMessageId) => {
		if (update.sessionUpdate === "user_message_chunk") return appendUserMessageChunk(conversation, update.content, userMessageId);
	},
	agent_message_chunk: (conversation, _acpx, update) => {
		if (update.sessionUpdate === "agent_message_chunk") return appendAgentMessageChunk(conversation, update.content, appendAgentText);
	},
	agent_thought_chunk: (conversation, _acpx, update) => {
		if (update.sessionUpdate === "agent_thought_chunk") return appendAgentMessageChunk(conversation, update.content, appendAgentThinking);
	},
	tool_call: applyToolUpdate,
	tool_call_update: applyToolUpdate,
	usage_update: (conversation, _acpx, update) => {
		if (update.sessionUpdate === "usage_update") applyUsageUpdate(conversation, update);
	},
	session_info_update: (conversation, _acpx, update) => {
		if (update.sessionUpdate === "session_info_update") applySessionInfoUpdate(conversation, update);
	},
	available_commands_update: (_conversation, acpx, update) => {
		if (update.sessionUpdate === "available_commands_update") acpx.available_commands = update.availableCommands.map((entry) => normalizeAvailableCommand(entry)).filter((entry) => entry !== void 0);
	},
	current_mode_update: (_conversation, acpx, update) => {
		if (update.sessionUpdate === "current_mode_update") acpx.current_mode_id = update.currentModeId;
	},
	config_option_update: (_conversation, acpx, update) => {
		if (update.sessionUpdate === "config_option_update") applyConfigOptionsModelState(acpx, deepClone(update.configOptions));
	}
};
function applyToolUpdate(conversation, _acpx, update) {
	if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return;
	return applyToolCallUpdate(ensureAgentMessage(conversation), update) ? conversation.messages.length - 1 : void 0;
}
function appendUserMessageChunk(conversation, content, messageId) {
	const userContent = contentToUserContent(content);
	if (!userContent) return;
	conversation.messages.push({ User: {
		id: resolveUserMessageId(messageId),
		content: [userContent]
	} });
	return conversation.messages.length - 1;
}
function appendAgentMessageChunk(conversation, content, append) {
	const text = extractText(content);
	if (!text) return;
	append(ensureAgentMessage(conversation), text);
	return conversation.messages.length - 1;
}
function applyUsageUpdate(conversation, update) {
	const usage = usageToTokenUsage(update);
	const cost = usageCost(update);
	if (!usage && !cost) return;
	if (usage) applyTokenUsage(conversation, usage);
	if (cost) conversation.cumulative_cost = cost;
}
function applyTokenUsage(conversation, usage, promptMessageId) {
	conversation.cumulative_token_usage = usage;
	const userId = promptMessageId ?? lastUserMessageId(conversation);
	if (userId) Object.defineProperty(conversation.request_token_usage, userId, {
		value: usage,
		writable: true,
		enumerable: true,
		configurable: true
	});
}
function applySessionInfoUpdate(conversation, update) {
	if (hasOwn(update, "title")) conversation.title = update.title ?? null;
	if (hasOwn(update, "updatedAt")) conversation.updated_at = update.updatedAt ?? conversation.updated_at;
}
// src/session/conversation-retention.ts
const MAX_RUNTIME_MESSAGES = 200;
const MAX_RUNTIME_AGENT_TEXT_CHARS = 8e3;
const MAX_RUNTIME_THINKING_CHARS = 4e3;
const MAX_RUNTIME_TOOL_IO_CHARS = 4e3;
const MAX_RUNTIME_REQUEST_TOKEN_USAGE = 100;
function trimRuntimeText(value, maxChars) {
	if (value.length <= maxChars) return value;
	let end = Math.max(0, maxChars - 3);
	const last = value.charCodeAt(end - 1);
	if (last >= 55296 && last <= 56319) end -= 1;
	return `${value.slice(0, end)}...`;
}
function trimConversationForRuntime(conversation) {
	if (conversation.messages.length > MAX_RUNTIME_MESSAGES) conversation.messages = conversation.messages.slice(-200);
	for (const message of conversation.messages) trimRuntimeMessage(message);
	const requestUsageEntries = Object.entries(conversation.request_token_usage);
	if (requestUsageEntries.length > MAX_RUNTIME_REQUEST_TOKEN_USAGE) conversation.request_token_usage = Object.fromEntries(requestUsageEntries.slice(-100));
}
function trimRuntimeMessage(message) {
	if (isUserMessage(message)) {
		trimRuntimeUserMessage(message.User);
		return;
	}
	if (isAgentMessage(message)) trimRuntimeAgentMessage(message.Agent);
}
function trimRuntimeUserMessage(message) {
	message.content = message.content.map((content) => {
		if ("Text" in content) return { Text: trimRuntimeText(content.Text, MAX_RUNTIME_AGENT_TEXT_CHARS) };
		return content;
	});
}
function trimRuntimeAgentMessage(message) {
	for (const content of message.content) trimRuntimeAgentContent(content);
	for (const result of Object.values(message.tool_results)) trimRuntimeToolResult(result);
}
function trimRuntimeAgentContent(content) {
	if ("Text" in content) content.Text = trimRuntimeText(content.Text, MAX_RUNTIME_AGENT_TEXT_CHARS);
	else if ("Thinking" in content) content.Thinking.text = trimRuntimeText(content.Thinking.text, MAX_RUNTIME_THINKING_CHARS);
	else if ("ToolUse" in content) content.ToolUse.raw_input = trimRuntimeText(content.ToolUse.raw_input, MAX_RUNTIME_TOOL_IO_CHARS);
}
function trimRuntimeToolResult(result) {
	if ("Text" in result.content) result.content.Text = trimRuntimeText(result.content.Text, MAX_RUNTIME_TOOL_IO_CHARS);
	if (typeof result.output === "string") result.output = trimRuntimeText(result.output, MAX_RUNTIME_TOOL_IO_CHARS);
}
// src/session/conversation-model.ts
function isoNow() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
function createSessionConversation(timestamp = isoNow()) {
	return createConversation(timestamp);
}
function cloneSessionConversation(conversation) {
	return conversation ? cloneConversation(conversation) : createSessionConversation();
}
function recordPromptSubmission(conversation, prompt, timestamp = isoNow(), messageId) {
	let promptMessageId = messageId;
	if (reducePromptSubmission(conversation, prompt, timestamp, () => promptMessageId ??= randomUUID()).messageIndex === void 0) return;
	trimConversationForRuntime(conversation);
	return promptMessageId;
}
function recordSessionUpdate(conversation, state, notification, timestamp = isoNow(), userMessageId) {
	const { acpx } = reduceSessionUpdate(conversation, state, notification, timestamp, userMessageId ?? randomUUID);
	trimConversationForRuntime(conversation);
	return acpx;
}
function recordPromptResponseUsage(conversation, usage, promptMessageId, timestamp = isoNow()) {
	if (!reducePromptResponseUsage(conversation, usage, promptMessageId, timestamp)) return false;
	trimConversationForRuntime(conversation);
	return true;
}
function recordClientOperation(conversation, state, _operation, timestamp = isoNow()) {
	const acpx = state ?? {};
	conversation.updated_at = timestamp;
	trimConversationForRuntime(conversation);
	return acpx;
}
// src/runtime/engine/lifecycle.ts
function createInitialSessionRecord(params) {
	const now = (/* @__PURE__ */ new Date()).toISOString();
	return {
		schema: "acpx.session.v1",
		acpxRecordId: params.recordId,
		acpSessionId: params.sessionId,
		agentSessionId: params.agentSessionId,
		agentCommand: params.agentCommand,
		agentArgv: params.agentArgv,
		cwd: params.cwd,
		name: params.name,
		createdAt: now,
		lastUsedAt: now,
		lastSeq: 0,
		eventLog: defaultSessionEventLog(params.recordId),
		closed: false,
		closedAt: void 0,
		...createSessionConversation(now),
		acpx: params.sessionOrigin ? { session_origin: params.sessionOrigin } : {}
	};
}
function applyLifecycleSnapshotToRecord(record, snapshot) {
	if (!snapshot) return;
	record.pid = snapshot.running ? snapshot.pid : void 0;
	record.agentStartedAt = snapshot.startedAt;
	if (snapshot.lastExit) {
		record.lastAgentExitCode = snapshot.lastExit.exitCode;
		record.lastAgentExitSignal = snapshot.lastExit.signal;
		record.lastAgentExitAt = snapshot.lastExit.exitedAt;
		record.lastAgentDisconnectReason = snapshot.lastExit.reason;
		return;
	}
	record.lastAgentExitCode = void 0;
	record.lastAgentExitSignal = void 0;
	record.lastAgentExitAt = void 0;
	record.lastAgentDisconnectReason = void 0;
}
function reconcileAgentSessionId(record, agentSessionId) {
	const normalized = normalizeAgentSessionId(agentSessionId);
	if (!normalized) return;
	record.agentSessionId = normalized;
}
function sessionHasAgentMessages(recordOrConversation) {
	return recordOrConversation.messages.some((message) => typeof message === "object" && message !== null && "Agent" in message);
}
function sessionHasAtMostOneUserMessage(recordOrConversation) {
	let userMessageCount = 0;
	for (const message of recordOrConversation.messages) if (typeof message === "object" && message !== null && "User" in message) {
		userMessageCount += 1;
		if (userMessageCount > 1) return false;
	}
	return true;
}
function sessionHasUserMessages(recordOrConversation) {
	return recordOrConversation.messages.some((message) => typeof message === "object" && message !== null && "User" in message);
}
function applyConversation(record, conversation) {
	record.title = conversation.title;
	record.updated_at = conversation.updated_at;
	record.messages = conversation.messages;
	record.cumulative_token_usage = conversation.cumulative_token_usage;
	record.cumulative_cost = conversation.cumulative_cost;
	record.request_token_usage = conversation.request_token_usage;
}
// src/runtime/engine/session-options.ts
function mergeSessionOptions(preferred, fallback) {
	const merged = { ...fallback };
	assignDefinedOption(merged, "model", preferred?.model);
	assignDefinedOption(merged, "allowedTools", preferred?.allowedTools);
	assignDefinedOption(merged, "maxTurns", preferred?.maxTurns);
	assignDefinedOption(merged, "systemPrompt", preferred?.systemPrompt);
	assignDefinedOption(merged, "env", mergeEnvRecords(fallback?.env, preferred?.env));
	return Object.keys(merged).length > 0 ? merged : void 0;
}
function normalizeSessionOptionShape(options) {
	const normalized = mergeSessionOptions(options, void 0);
	if (normalized?.env !== void 0 && Object.keys(normalized.env).length === 0) delete normalized.env;
	return normalized && Object.keys(normalized).length > 0 ? normalized : void 0;
}
function mergeEnvRecords(fallback, preferred) {
	if (!fallback && !preferred) return;
	return {
		...fallback,
		...preferred
	};
}
function assignDefinedOption(target, key, value) {
	if (value !== void 0) target[key] = value;
}
function persistSessionOptions(record, options) {
	const next = options === void 0 ? void 0 : persistedSessionOptions(options);
	if (next !== void 0) {
		record.acpx = {
			...record.acpx,
			session_options: next
		};
		return;
	}
	if (!record.acpx) return;
	delete record.acpx.session_options;
}
function sessionOptionsFromRecord(record) {
	const stored = record.acpx?.session_options;
	if (!stored) return;
	const sessionOptions = {};
	assignDefinedOption(sessionOptions, "model", nonEmptyString(stored.model));
	assignDefinedOption(sessionOptions, "allowedTools", storedAllowedTools(stored.allowed_tools));
	assignDefinedOption(sessionOptions, "maxTurns", storedMaxTurns(stored.max_turns));
	assignDefinedOption(sessionOptions, "systemPrompt", normalizeSystemPromptOption(stored.system_prompt));
	assignDefinedOption(sessionOptions, "env", storedEnvRecord(stored.env));
	return Object.keys(sessionOptions).length > 0 ? sessionOptions : void 0;
}
function persistedSessionOptions(options) {
	const next = {
		model: nonEmptyString(options.model),
		allowed_tools: Array.isArray(options.allowedTools) ? [...options.allowedTools] : void 0,
		max_turns: typeof options.maxTurns === "number" ? options.maxTurns : void 0,
		system_prompt: normalizeSystemPromptOption(options.systemPrompt),
		env: storedEnvRecord(options.env)
	};
	return hasPersistedSessionOptions(next) ? next : void 0;
}
function hasPersistedSessionOptions(options) {
	return options.model !== void 0 || options.allowed_tools !== void 0 || options.max_turns !== void 0 || options.system_prompt !== void 0 || options.env !== void 0;
}
function storedEnvRecord(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return;
	const entries = Object.entries(value);
	const result = {};
	for (const [key, raw] of entries) {
		if (typeof raw !== "string") continue;
		Object.defineProperty(result, key, {
			value: raw,
			writable: true,
			enumerable: true,
			configurable: true
		});
	}
	return Object.keys(result).length > 0 ? result : void 0;
}
function normalizeSystemPromptOption(value) {
	const prompt = nonEmptyPromptText(value);
	if (prompt !== void 0) return prompt;
	const append = appendedSystemPrompt(value);
	return append === void 0 ? void 0 : { append };
}
function appendedSystemPrompt(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return;
	return nonEmptyPromptText(value.append);
}
function nonEmptyPromptText(value) {
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
function storedAllowedTools(value) {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : void 0;
}
function storedMaxTurns(value) {
	return typeof value === "number" ? value : void 0;
}
function nonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
// src/session/mode-preference.ts
function ensureAcpxState(state) {
	return state ?? {};
}
function normalizeModeId(modeId) {
	if (typeof modeId !== "string") return;
	const trimmed = modeId.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function normalizeModelId(modelId) {
	if (typeof modelId !== "string") return;
	const trimmed = modelId.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function getDesiredModeId(state) {
	return normalizeModeId(state?.desired_mode_id);
}
function getDesiredConfigOptions(state) {
	const desired = state?.desired_config_options;
	if (!desired) return {};
	return Object.fromEntries(Object.entries(desired).filter(([, value]) => typeof value === "string"));
}
function setDesiredModeId(record, modeId) {
	const acpx = ensureAcpxState(record.acpx);
	const normalized = normalizeModeId(modeId);
	if (normalized) acpx.desired_mode_id = normalized;
	else delete acpx.desired_mode_id;
	record.acpx = acpx;
}
function clearDesiredConfigOption(state, configId) {
	if (typeof configId !== "string" || !state.desired_config_options) return;
	const desired = { ...state.desired_config_options };
	delete desired[configId];
	if (Object.keys(desired).length > 0) state.desired_config_options = desired;
	else delete state.desired_config_options;
}
function getDesiredModelId(state) {
	return normalizeModelId(state?.session_options?.model);
}
function syncAdvertisedModelState(record, models) {
	if (!models) return;
	const acpx = ensureAcpxState(record.acpx);
	applyAdvertisedModelState(acpx, models);
	record.acpx = acpx;
}
// src/session/model-application.ts
function currentModelIdFromSetModelResponse(response, fallbackModelId) {
	return modelStateFromConfigOptions(response?.configOptions)?.currentModelId ?? fallbackModelId;
}
async function applyRequestedModelIfAdvertised(params) {
	const requestedModel = typeof params.requestedModel === "string" ? params.requestedModel.trim() : "";
	if (!requestedModel) return { applied: false };
	const warning = assertRequestedModelSupported({
		requestedModel,
		models: params.models,
		agentCommand: params.agentCommand,
		context: "apply"
	});
	if (warning) params.onWarning?.(warning);
	if (!params.models) return { applied: false };
	const resolvedModelId = resolveRequestedModelId({
		...params,
		requestedModel
	});
	if (params.models.currentModelId === resolvedModelId) return {
		applied: true,
		modelId: requestedModel,
		resolvedModelId
	};
	return {
		applied: true,
		modelId: requestedModel,
		resolvedModelId,
		response: await withTimeout(params.client.setSessionModel(params.sessionId, requestedModel, params.models, params.authority), params.timeoutMs)
	};
}
// src/session/config-options.ts
function applyConfigOptionsToState(state, configOptions) {
	const acpxState = cloneSessionAcpxState(state) ?? {};
	applyConfigOptionsModelState(acpxState, configOptions);
	return acpxState;
}
function applyConfigOptionsToRecord(record, result) {
	const configOptions = result?.configOptions;
	if (!Array.isArray(configOptions)) return;
	record.acpx = applyConfigOptionsToState(record.acpx, configOptions);
}
function applyInitialModelSelection(record, originalModels, modelApplication) {
	applyConfigOptionsToRecord(record, modelApplication.response);
	const configOptions = modelApplication.response?.configOptions;
	syncAdvertisedModelState(record, Array.isArray(configOptions) ? modelStateFromConfigOptions(configOptions) : originalModels);
	if (modelApplication.applied) record.acpx = applyModelSelection(record.acpx, modelApplication.modelId, modelApplication.response, modelApplication.resolvedModelId);
}
function applyAcceptedConfigOptions(state, response, selection) {
	const next = cloneSessionAcpxState(state) ?? {};
	if (!Array.isArray(response?.configOptions)) {
		const option = next.config_options?.find((entry) => entry.id === selection.configId);
		if (option) option.currentValue = selection.value;
		return next;
	}
	applyConfigOptionsModelState(next, response.configOptions);
	reconcileDesiredConfigOptions(next, response.configOptions);
	return next;
}
function reconcileDesiredConfigOptions(state, configOptions) {
	if (!state.desired_config_options) return;
	const desiredEntries = [];
	for (const option of configOptions) if (typeof option.currentValue === "string" && Object.hasOwn(state.desired_config_options, option.id)) desiredEntries.push([option.id, option.currentValue]);
	if (desiredEntries.length > 0) state.desired_config_options = Object.fromEntries(desiredEntries);
	else delete state.desired_config_options;
}
function applyModelSelection(state, modelId, response, resolvedModelId = modelId) {
	const modelConfigId = advertisedModelState(state)?.configId;
	const next = applyAcceptedConfigOptions(state, response, {
		configId: modelConfigId,
		value: resolvedModelId
	});
	next.session_options = {
		...next.session_options,
		model: modelId
	};
	next.current_model_id = currentModelIdFromSetModelResponse(response, resolvedModelId);
	clearDesiredConfigOption(next, modelConfigId ?? advertisedModelState(next)?.configId);
	return next;
}
function isModelConfigSelection(configId, response, modelConfigId) {
	return configId === modelConfigId || configId === modelStateFromConfigOptions(response?.configOptions)?.configId;
}
function applyConfigOptionSelection(state, configId, value, response, modelConfigId = advertisedModelState(state)?.configId, resolvedValue = value) {
	if (isModelConfigSelection(configId, response, modelConfigId)) return applyModelSelection(state, value, response, resolvedValue);
	const next = cloneSessionAcpxState(state) ?? {};
	next.desired_config_options = {
		...next.desired_config_options,
		[configId]: value
	};
	return applyAcceptedConfigOptions(next, response, {
		configId,
		value
	});
}
// src/session/execution/direct-lifetime.ts
function ownDirectClient(client, signal) {
	let closing;
	const cancel = async () => {
		await withTimeout(client.cancelActivePrompt(2500), 2500).catch(() => {});
		await client.close();
	};
	const onAbort = () => {
		closing ??= cancel();
		closing.catch(() => {});
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) onAbort();
	const release = () => signal?.removeEventListener("abort", onAbort);
	return Object.assign(() => {
		release();
		closing ??= client.close();
		return closing;
	}, { release });
}
function directExecutionError(error, signal) {
	return signal?.aborted && error instanceof AgentDisconnectedError ? signal.reason : error;
}
// src/runtime/engine/reconnect.ts
const SESSION_LOAD_UNSUPPORTED_CODES = /* @__PURE__ */ new Set([-32601, -32602]);
function createReplayState(authority) {
	let failure;
	return {
		acknowledged: false,
		authority: authority ? { assertActive() {
			try {
				assertControlAuthority(authority);
			} catch (error) {
				failure = { error };
				throw error;
			}
		} } : void 0,
		isAuthorityFailure: (error) => failure !== void 0 && failure.error === error
	};
}
function rethrowAuthorityFailure(replay, error) {
	if (replay.isAuthorityFailure(error)) throw error;
}
function shouldFallbackToNewSession(error, record) {
	if (isHardReconnectFailure(error)) return false;
	const acp = extractAcpError(error);
	if (isAcpResourceNotFoundError(error) || isUnsupportedSessionLoadAcpError(acp)) return true;
	return !sessionHasAgentMessages(record) && isFallbackSafeEmptySessionError(error, acp);
}
function isHardReconnectFailure(error) {
	return error instanceof TimeoutError || error instanceof InterruptedError;
}
function isUnsupportedSessionLoadAcpError(acp) {
	return !!acp && SESSION_LOAD_UNSUPPORTED_CODES.has(acp.code);
}
function isFallbackSafeEmptySessionError(error, acp) {
	return isAcpQueryClosedBeforeResponseError(error) || acp?.code === -32603;
}
function requiresSameSession(resumePolicy) {
	return resumePolicy === "same-session-only";
}
function makeSessionResumeRequiredError(params) {
	return new SessionResumeRequiredError(`Persistent ACP session ${params.record.acpSessionId} could not be resumed: ${params.reason}`, { cause: params.cause instanceof Error ? params.cause : void 0 });
}
async function replayDesiredMode(params) {
	if (!params.desiredModeId) return;
	try {
		await withTimeout(params.client.setSessionMode(params.sessionId, params.desiredModeId, params.replay.authority), params.timeoutMs);
		params.replay.acknowledged = true;
		if (params.verbose) process.stderr.write(`[acpx] replayed desired mode ${params.desiredModeId} on fresh ACP session ${params.sessionId} (previous ${params.previousSessionId})\n`);
		return {
			models: advertisedModelState(params.record.acpx),
			configOptionsPresent: params.record.acpx?.config_options !== void 0
		};
	} catch (error) {
		rethrowAuthorityFailure(params.replay, error);
		throw new SessionModeReplayError(`Failed to replay saved session mode ${params.desiredModeId} on fresh ACP session ${params.sessionId}: ${formatErrorMessage(error)}`, {
			cause: error instanceof Error ? error : void 0,
			retryable: true
		});
	}
}
function canReplayModel(desiredModelId, models, createdFreshSession) {
	return Boolean(desiredModelId) && (createdFreshSession || models !== void 0);
}
async function replayDesiredModel(params) {
	if (!canReplayModel(params.desiredModelId, params.models, params.createdFreshSession)) return { replayed: false };
	try {
		emitModelSupportWarning(assertRequestedModelSupported({
			requestedModel: params.desiredModelId,
			models: params.models,
			agentCommand: params.record.agentCommand,
			context: "replay"
		}), params.suppressWarnings);
		if (!params.models) return { replayed: false };
		const resolvedModelId = resolveRequestedModelId({
			requestedModel: params.desiredModelId,
			models: params.models,
			agentCommand: params.record.agentCommand
		});
		const response = await withTimeout(params.client.setSessionModel(params.sessionId, params.desiredModelId, params.models, params.replay.authority), params.timeoutMs);
		params.replay.acknowledged = true;
		params.record.acpx = applyModelSelection(params.record.acpx, params.desiredModelId, response, resolvedModelId);
		const models = advertisedModelState(params.record.acpx);
		if (params.verbose) process.stderr.write(`[acpx] replayed desired model ${params.desiredModelId} on ACP session ${params.sessionId} (previous ${params.previousSessionId})\n`);
		return {
			replayed: true,
			models,
			configOptions: response?.configOptions
		};
	} catch (error) {
		rethrowAuthorityFailure(params.replay, error);
		throw new SessionModelReplayError(`Failed to replay saved session model ${params.desiredModelId} on ACP session ${params.sessionId}: ${formatErrorMessage(error)}`, {
			cause: error instanceof Error ? error : void 0,
			retryable: true
		});
	}
}
function emitModelSupportWarning(warning, suppressWarnings) {
	if (warning && !suppressWarnings) process.stderr.write(`[acpx] warning: ${warning}\n`);
}
async function replayDesiredConfigOptions(params) {
	let result = { replayed: false };
	let acceptedConfigOptions = params.acceptedConfigOptions;
	const replacingKey = resolveReplacingConfigOptionId(params.replacingConfigOption, params.record);
	for (const [configId, value] of Object.entries(params.desiredConfigOptions)) {
		if (configId === replacingKey || acceptedConfigOptions && !acceptsSavedConfigValue(acceptedConfigOptions.find((option) => option.id === configId), value)) continue;
		try {
			const models = advertisedModelState(params.record.acpx);
			const { modelConfigId, resolvedValue } = resolveRequestedConfigOption({
				configId,
				value,
				models,
				agentCommand: params.record.agentCommand
			});
			const response = await withTimeout(params.client.setSessionConfigOption(params.sessionId, configId, value, models, params.replay.authority), params.timeoutMs);
			params.replay.acknowledged = true;
			params.record.acpx = applyConfigOptionSelection(params.record.acpx, configId, value, response, modelConfigId, resolvedValue);
			acceptedConfigOptions = params.record.acpx.config_options;
			result = {
				replayed: true,
				models: advertisedModelState(params.record.acpx)
			};
			if (params.verbose) process.stderr.write(`[acpx] replayed desired config option ${configId} on ACP session ${params.sessionId} (previous ${params.previousSessionId})\n`);
		} catch (error) {
			rethrowAuthorityFailure(params.replay, error);
			throw new SessionConfigOptionReplayError(`Failed to replay saved session config option ${configId} on ACP session ${params.sessionId}: ${formatErrorMessage(error)}`, {
				cause: error instanceof Error ? error : void 0,
				retryable: true
			});
		}
	}
	return result;
}
function restoreOriginalSessionState(params) {
	params.record.acpSessionId = params.sessionId;
	params.record.agentSessionId = params.agentSessionId;
}
async function connectAndLoadSession(options) {
	const record = options.record;
	const client = options.client;
	assertControlAuthority(options.authority);
	const sameSessionOnly = requiresSameSession(options.resumePolicy) || Boolean(record.importedFrom);
	const originalSessionId = record.acpSessionId;
	const originalAgentSessionId = record.agentSessionId;
	const originalAcpx = cloneSessionAcpxState(record.acpx);
	const desiredModeId = options.replacingMode ? void 0 : getDesiredModeId(record.acpx);
	const desiredModelId = getDesiredModelId(record.acpx);
	const desiredConfigOptions = getDesiredConfigOptions(record.acpx);
	const storedProcessAlive = isProcessAlive(record.pid);
	logReconnectAttempt(record, storedProcessAlive, Boolean(record.pid) && !storedProcessAlive, options.verbose);
	const reusingLoadedSession = client.hasReusableSession(record.acpSessionId);
	if (reusingLoadedSession) incrementPerfCounter("runtime.connect_and_load.reused_session");
	else await withTimeout(client.start(options.authority, { sessionOptions: mergeSessionOptions(options.sessionOptions, sessionOptionsFromRecord(record)) }), options.timeoutMs);
	assertControlAuthority(options.authority);
	options.onClientAvailable?.(options.activeController);
	applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
	record.closed = false;
	record.closedAt = void 0;
	options.onConnectedRecord?.(record);
	const loadState = await loadOrCreateRuntimeSession({
		client,
		record,
		reusingLoadedSession,
		sameSessionOnly,
		timeoutMs: options.timeoutMs,
		authority: options.authority,
		promptRecorded: options.promptRecorded
	});
	const { resumed, loadError, sessionId, createdFreshSession, pendingAgentSessionId, sessionModels } = loadState;
	applyReconnectedModelState(record, sessionModels, loadState.configOptionsPresent, loadState.legacyModelMetadataPresent, createdFreshSession);
	const preferenceReplay = await replaySessionPreferences({
		client,
		record,
		createdFreshSession,
		reusingLoadedSession,
		replacingConfigOption: options.replacingConfigOption,
		sessionId,
		pendingAgentSessionId,
		originalSessionId,
		originalAgentSessionId,
		originalAcpx,
		desiredModeId,
		desiredModelId,
		desiredConfigOptions,
		sessionModels,
		timeoutMs: options.timeoutMs,
		verbose: options.verbose,
		suppressWarnings: options.suppressWarnings,
		authority: options.authority
	});
	applyReconnectedModelState(record, resolveModelsAfterReplay(preferenceReplay, sessionModels), resolveConfigOptionsPresenceAfterReplay(preferenceReplay, loadState.configOptionsPresent), loadState.legacyModelMetadataPresent, createdFreshSession);
	options.onSessionIdResolved?.(sessionId);
	return {
		sessionId,
		agentSessionId: record.agentSessionId,
		resumed,
		loadError
	};
}
function resolveModelsAfterReplay(replay, initialModels) {
	const models = resolveModeReplayModels(replay.modeMetadata, initialModels);
	if (replay.configReplay.replayed) return replay.configReplay.models ?? preserveLegacyModels(replay.modelReplay.replayed ? replay.modelReplay.models : models);
	return replay.modelReplay.replayed ? replay.modelReplay.models : models;
}
function resolveModeReplayModels(modeMetadata, initialModels) {
	return modeMetadata ? modeMetadata.models : initialModels;
}
function preserveLegacyModels(models) {
	return models && !models.configId ? models : void 0;
}
function resolveConfigOptionsPresenceAfterReplay(replay, initiallyPresent) {
	return initiallyPresent || replay.modeMetadata?.configOptionsPresent === true || replay.configReplay.replayed || replay.modelReplay.configOptions !== void 0;
}
function applyReconnectedModelState(record, sessionModels, configOptionsPresent, legacyModelMetadataPresent, createdFreshSession) {
	clearOmittedFreshSessionConfigOptions(record, createdFreshSession, configOptionsPresent);
	if (sessionModels) {
		if (legacyModelMetadataPresent && !sessionModels.configId && record.acpx) removeModelConfigOptions(record.acpx);
		syncAdvertisedModelState(record, sessionModels);
	} else clearRemovedModelState(record, legacyModelMetadataPresent || createdFreshSession);
}
function clearOmittedFreshSessionConfigOptions(record, createdFreshSession, configOptionsPresent) {
	if (createdFreshSession && !configOptionsPresent && record.acpx) delete record.acpx.config_options;
}
function clearRemovedModelState(record, shouldClear) {
	if (shouldClear && record.acpx) clearAdvertisedModelState(record.acpx);
}
function logReconnectAttempt(record, storedProcessAlive, shouldReconnect, verbose) {
	if (!verbose) return;
	if (storedProcessAlive) {
		process.stderr.write(`[acpx] saved session pid ${record.pid} is running; reconnecting to saved ACP session\n`);
		return;
	}
	if (shouldReconnect) process.stderr.write(`[acpx] saved session pid ${record.pid} is dead; respawning agent and attempting session reconnect\n`);
}
function replacesModel(replacingConfigOption, models, originalAcpx) {
	const key = replacingConfigOption?.key;
	return key !== void 0 && (key === "model" || key === models?.configId || key === advertisedModelState(originalAcpx)?.configId);
}
function acceptsSavedConfigValue(option, value) {
	if (!option || option.type !== "select") return false;
	return option.currentValue === value || option.options.some((entry) => "options" in entry ? entry.options.some((choice) => choice.value === value) : entry.value === value);
}
function resolveReplacingConfigOptionId(replacement, record) {
	return replacement?.resolve?.(record) ?? replacement?.key;
}
async function replaySessionPreferences(params) {
	if (params.reusingLoadedSession) return {
		modelReplay: { replayed: false },
		configReplay: { replayed: false }
	};
	let modelReplay = { replayed: false };
	let configReplay = { replayed: false };
	let modeMetadata;
	const replay = createReplayState(params.authority);
	try {
		assertControlAuthority(replay.authority);
		modeMetadata = await replayDesiredMode({
			client: params.client,
			record: params.record,
			sessionId: params.sessionId,
			desiredModeId: params.createdFreshSession ? params.desiredModeId : void 0,
			replay,
			previousSessionId: params.originalSessionId,
			timeoutMs: params.timeoutMs,
			verbose: params.verbose
		});
		const effectiveModels = resolveModeReplayModels(modeMetadata, params.sessionModels);
		const replacingModel = replacesModel(params.replacingConfigOption, effectiveModels, params.originalAcpx);
		modelReplay = await replayDesiredModel({
			client: params.client,
			sessionId: params.sessionId,
			desiredModelId: replacingModel ? void 0 : params.desiredModelId,
			replay,
			previousSessionId: params.originalSessionId,
			record: params.record,
			models: effectiveModels,
			createdFreshSession: params.createdFreshSession,
			timeoutMs: params.timeoutMs,
			verbose: params.verbose,
			suppressWarnings: params.suppressWarnings
		});
		configReplay = await replayDesiredConfigOptions({
			client: params.client,
			record: params.record,
			sessionId: params.sessionId,
			desiredConfigOptions: replacingModel ? {} : params.desiredConfigOptions,
			replay,
			acceptedConfigOptions: modelReplay.configOptions,
			replacingConfigOption: replacingModel ? void 0 : params.replacingConfigOption,
			previousSessionId: params.originalSessionId,
			timeoutMs: params.timeoutMs,
			verbose: params.verbose
		});
	} catch (error) {
		settleFailedReplay(params, replay, error);
		if (params.verbose) process.stderr.write(`[acpx] ${formatErrorMessage(error)}\n`);
		throw error;
	}
	params.record.acpSessionId = params.sessionId;
	reconcileAgentSessionId(params.record, params.pendingAgentSessionId);
	return {
		modelReplay,
		configReplay,
		modeMetadata
	};
}
function settleFailedReplay(params, replay, error) {
	if (replay.isAuthorityFailure(error) && replay.acknowledged) {
		params.record.acpSessionId = params.sessionId;
		reconcileAgentSessionId(params.record, params.pendingAgentSessionId);
	} else {
		restoreOriginalSessionState({
			record: params.record,
			sessionId: params.originalSessionId,
			agentSessionId: params.originalAgentSessionId
		});
		params.record.acpx = cloneSessionAcpxState(params.originalAcpx);
	}
}
async function loadOrCreateRuntimeSession(params) {
	if (params.reusingLoadedSession) return {
		sessionId: params.record.acpSessionId,
		pendingAgentSessionId: params.record.agentSessionId,
		sessionModels: void 0,
		configOptionsPresent: false,
		legacyModelMetadataPresent: false,
		resumed: true,
		createdFreshSession: false
	};
	if (params.client.supportsResumeSession()) return await loadRuntimeSession(params, true);
	if (params.client.supportsLoadSession()) return await loadRuntimeSession(params, false);
	if (params.sameSessionOnly) throw makeSessionResumeRequiredError({
		record: params.record,
		reason: "agent does not support session/resume or session/load"
	});
	return await createFreshRuntimeSession(params.client, params.record, params.timeoutMs, params.authority);
}
async function loadRuntimeSession(params, resume) {
	try {
		const loadResult = await withTimeout(resume ? params.client.resumeSession(params.record.acpSessionId, params.record.cwd, params.authority) : params.client.loadSessionWithOptions(params.record.acpSessionId, params.record.cwd, {
			suppressReplayUpdates: true,
			...params.authority ? { authority: params.authority } : {}
		}), params.timeoutMs);
		reconcileAgentSessionId(params.record, loadResult.agentSessionId);
		applyConfigOptionsToRecord(params.record, loadResult);
		return {
			sessionId: params.record.acpSessionId,
			pendingAgentSessionId: params.record.agentSessionId,
			sessionModels: loadResult.models,
			configOptionsPresent: loadResult.configOptionsPresent,
			legacyModelMetadataPresent: loadResult.legacyModelMetadataPresent,
			resumed: true,
			createdFreshSession: false
		};
	} catch (error) {
		rethrowCancelledLoad(error, params.authority);
		return await recoverRuntimeSessionLoadFailure(params, error);
	}
}
function rethrowCancelledLoad(error, authority) {
	const signal = authority?.signal;
	if (signal?.aborted && (error instanceof AgentDisconnectedError || error === signal.reason)) throw signal.reason;
}
async function recoverRuntimeSessionLoadFailure(params, error) {
	const loadError = formatErrorMessage(error);
	if (!canRecoverLoadWithFreshSession(params, error)) {
		if (params.sameSessionOnly) throw makeSessionResumeRequiredError({
			record: params.record,
			reason: loadError,
			cause: error
		});
		throw error;
	}
	return {
		...await createFreshRuntimeSession(params.client, params.record, params.timeoutMs, params.authority),
		loadError
	};
}
function canRecoverLoadWithFreshSession(params, error) {
	if (!params.sameSessionOnly) return shouldFallbackToNewSession(error, params.record);
	return isUnpromptedNewSession(params.record, params.promptRecorded) && extractAcpError(error)?.code === -32603;
}
function isUnpromptedNewSession(record, promptRecorded = false) {
	return record.acpx?.session_origin === "new" && !record.importedFrom && !sessionHasAgentMessages(record) && !record.messages.includes("Resume") && (promptRecorded ? sessionHasAtMostOneUserMessage(record) : !sessionHasUserMessages(record));
}
async function createFreshRuntimeSession(client, record, timeoutMs, authority) {
	const createdSession = await withTimeout(client.createSession(record.cwd, authority), timeoutMs);
	record.acpx = {
		...record.acpx,
		session_origin: "new"
	};
	applyConfigOptionsToRecord(record, createdSession);
	return {
		sessionId: createdSession.sessionId,
		pendingAgentSessionId: createdSession.agentSessionId,
		sessionModels: createdSession.models,
		configOptionsPresent: createdSession.configOptionsPresent,
		legacyModelMetadataPresent: createdSession.legacyModelMetadataPresent,
		resumed: false,
		createdFreshSession: true
	};
}
// src/runtime/engine/connected-session.ts
function createActiveSessionController(params) {
	const getActiveSessionId = () => params.getActiveSessionId();
	return {
		hasActivePrompt: () => params.client.hasActivePrompt(),
		requestCancelActivePrompt: async () => await params.client.requestCancelActivePrompt(),
		setSessionMode: async (modeId) => {
			await params.client.setSessionMode(getActiveSessionId(), modeId);
		},
		setSessionModel: async (modelId) => {
			const models = advertisedModelState(params.record.acpx);
			const response = await params.client.setSessionModel(getActiveSessionId(), modelId, models);
			applyConfigOptionsToRecord(params.record, response);
			return response;
		},
		setSessionConfigOption: async (configId, value) => {
			return await params.client.setSessionConfigOption(getActiveSessionId(), configId, value, advertisedModelState(params.record.acpx));
		}
	};
}
async function withConnectedSession(options) {
	const record = await options.loadRecord(options.sessionRecordId);
	assertControlAuthority(options.authority);
	const clientOptions = {
		agentCommand: record.agentCommand,
		agentArgv: record.agentArgv,
		cwd: absolutePath(record.cwd),
		mcpServers: options.mcpServers,
		permissionMode: options.permissionMode ?? "approve-reads",
		nonInteractivePermissions: options.nonInteractivePermissions,
		permissionPolicy: options.permissionPolicy,
		onPermissionRequest: options.onPermissionRequest,
		authCredentials: options.authCredentials,
		authPolicy: options.authPolicy,
		fs: options.fs,
		terminal: options.terminal,
		elicitationModes: options.elicitationModes,
		verbose: options.verbose,
		sessionOptions: sessionOptionsFromRecord(record)
	};
	const client = options.createClient?.(clientOptions) ?? new AcpClient(clientOptions);
	let activeSessionIdForControl = record.acpSessionId;
	let notifiedClientAvailable = false;
	const activeController = createActiveSessionController({
		client,
		record,
		getActiveSessionId: () => activeSessionIdForControl
	});
	try {
		return await withInterrupt(async () => {
			const { sessionId, resumed, loadError } = await connectAndLoadSession({
				client,
				record,
				resumePolicy: options.resumePolicy,
				replacingMode: options.replacingMode,
				replacingConfigOption: options.replacingConfigOption,
				authority: options.authority,
				timeoutMs: options.timeoutMs,
				verbose: options.verbose,
				activeController,
				onClientAvailable: (controller) => {
					options.onClientAvailable?.(controller);
					notifiedClientAvailable = true;
				},
				onConnectedRecord: options.onConnectedRecord,
				onSessionIdResolved: (sessionIdValue) => {
					activeSessionIdForControl = sessionIdValue;
				}
			});
			assertControlAuthority(options.authority);
			const value = await options.run({
				record,
				client,
				activeController,
				sessionId,
				resumed,
				loadError
			});
			const now = isoNow$1();
			record.lastUsedAt = now;
			record.closed = false;
			record.closedAt = void 0;
			record.protocolVersion = client.initializeResult?.protocolVersion;
			record.agentCapabilities = client.initializeResult?.agentCapabilities;
			applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
			await options.saveRecord(record);
			return {
				value,
				record,
				resumed,
				loadError
			};
		}, async () => {
			if (options.onInterrupt) await options.onInterrupt({
				client,
				record
			});
			else await client.cancelActivePrompt(2500);
			applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
			record.lastUsedAt = isoNow$1();
			await options.saveRecord(record).catch(() => {});
			await client.close();
		});
	} finally {
		if (notifiedClientAvailable) options.onClientClosed?.();
		await client.close();
		applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
		await options.saveRecord(record).catch(() => {});
	}
}
// src/session/execution/prompt-runner.ts
function buildDirectConnectedSessionOptions(options, run) {
	return {
		sessionRecordId: options.sessionRecordId,
		replacingMode: options.replacingMode,
		replacingConfigOption: options.replacingConfigOption,
		loadRecord: resolveSessionRecord,
		saveRecord: writeSessionRecord,
		mcpServers: options.mcpServers,
		nonInteractivePermissions: options.nonInteractivePermissions,
		authCredentials: options.authCredentials,
		authPolicy: options.authPolicy,
		fs: options.fs,
		terminal: options.terminal,
		timeoutMs: options.timeoutMs,
		verbose: options.verbose,
		onClientAvailable: (controller) => {
			options.onClientAvailable?.(controller);
		},
		onClientClosed: options.onClientClosed,
		run
	};
}
function toSessionMutationResult(result) {
	return {
		record: result.record,
		resumed: result.resumed,
		loadError: result.loadError
	};
}
async function withOwnedDirectSession(options) {
	const waiting = new AbortController();
	const timeoutMs = options.timeoutMs;
	const timer = timeoutMs != null && timeoutMs > 0 ? setTimeout(() => waiting.abort(new TimeoutError(timeoutMs)), timeoutMs) : void 0;
	let ownership;
	let recordId;
	try {
		recordId = (await options.loadRecord(options.sessionRecordId)).acpxRecordId;
		ownership = await acquireSessionTurn(recordId, waiting.signal);
	} catch (error) {
		waiting.signal.throwIfAborted();
		throw error;
	} finally {
		clearTimeout(timer);
	}
	try {
		return await withConnectedSession({
			...options,
			sessionRecordId: recordId
		});
	} finally {
		await ownership[Symbol.asyncDispose]();
	}
}
async function runSessionSetModeDirect(options) {
	return toSessionMutationResult(await withOwnedDirectSession(buildDirectConnectedSessionOptions({
		...options,
		replacingMode: true
	}, async ({ client, sessionId, record }) => {
		await withTimeout(client.setSessionMode(sessionId, options.modeId), options.timeoutMs);
		setDesiredModeId(record, options.modeId);
	})));
}
async function runSessionSetModelDirect(options) {
	const result = await withOwnedDirectSession(buildDirectConnectedSessionOptions({
		...options,
		replacingConfigOption: { key: "model" }
	}, async ({ client, sessionId, record }) => {
		const models = advertisedModelState(record.acpx);
		const resolvedModelId = resolveRequestedModelId({
			requestedModel: options.modelId,
			models,
			agentCommand: record.agentCommand
		});
		const response = await withTimeout(client.setSessionModel(sessionId, options.modelId, models), options.timeoutMs);
		record.acpx = applyModelSelection(record.acpx, options.modelId, response, resolvedModelId);
		return response;
	}));
	return {
		...toSessionMutationResult(result),
		response: result.value
	};
}
async function runSessionSetConfigOptionDirect(options) {
	const result = await withOwnedDirectSession(buildDirectConnectedSessionOptions({
		...options,
		replacingConfigOption: { key: options.configId }
	}, async ({ client, sessionId, record }) => {
		const models = advertisedModelState(record.acpx);
		const { modelConfigId, resolvedValue } = resolveRequestedConfigOption({
			configId: options.configId,
			value: options.value,
			models,
			agentCommand: record.agentCommand
		});
		const response = await withTimeout(client.setSessionConfigOption(sessionId, options.configId, options.value, models), options.timeoutMs);
		record.acpx = applyConfigOptionSelection(record.acpx, options.configId, options.value, response, modelConfigId, resolvedValue);
		return response;
	}));
	return {
		record: result.record,
		response: result.value,
		resumed: result.resumed,
		loadError: result.loadError
	};
}
// src/session/execution/windows-process-command.ts
function skipSeparators(value) {
	return value.replace(/^[ \t]+/u, "");
}
function readQuote(commandLine, state, executable) {
	if (!executable && state.quoted && commandLine[state.index + 1] === "\"") {
		state.value += "\"";
		state.index += 2;
	} else {
		state.quoted = !state.quoted;
		state.index += 1;
	}
}
function readBackslashes(commandLine, state, executable) {
	const start = state.index;
	while (commandLine[state.index] === "\\") state.index += 1;
	const count = state.index - start;
	if (executable || commandLine[state.index] !== "\"") state.value += "\\".repeat(count);
	else {
		state.value += "\\".repeat(Math.floor(count / 2));
		if (count % 2 === 1) {
			state.value += "\"";
			state.index += 1;
		} else readQuote(commandLine, state, false);
	}
}
function readArgument(commandLine, start, executable) {
	const state = {
		value: "",
		index: start,
		quoted: false
	};
	while (state.index < commandLine.length) {
		const char = commandLine[state.index];
		if (!state.quoted && /[ \t]/u.test(char)) break;
		if (char === "\\") readBackslashes(commandLine, state, executable);
		else if (char === "\"") readQuote(commandLine, state, executable);
		else {
			state.value += char;
			state.index += 1;
		}
	}
	return state.quoted ? void 0 : state;
}
function readBatchCommand(commandLine) {
	const body = commandLine.match(/^[ \t]+\/d[ \t]+\/s[ \t]+\/c[ \t]+"([\s\S]*)"$/iu)?.[1];
	if (!body) return;
	return readBatchExecutable(body);
}
function readBatchExecutable(body) {
	let command = "";
	for (let index = 0; index < body.length; index += 1) {
		const char = body[index];
		if (char === "^") {
			index += 1;
			if (index === body.length) return;
			command += body[index];
		} else if (/[ \t]/u.test(char)) break;
		else if (/["\r\n]/u.test(char)) return;
		else command += char;
	}
	return /\.(?:cmd|bat)$/iu.test(command) ? command : void 0;
}
/** Decode process observations, not saved command identities or POSIX launch strings. */
function splitWindowsProcessCommandLine(commandLine) {
	const line = skipSeparators(commandLine);
	const executable = readArgument(line, 0, true);
	if (!executable?.value) return [];
	const argv = [executable.value];
	if (path.win32.basename(executable.value).toLowerCase() === "cmd.exe") {
		const batch = readBatchCommand(line.slice(executable.index));
		return batch ? [...argv, batch] : argv;
	}
	let rest = skipSeparators(line.slice(executable.index));
	while (rest) {
		const argument = readArgument(rest, 0, false);
		if (!argument) return [];
		argv.push(argument.value);
		rest = skipSeparators(rest.slice(argument.index));
	}
	return argv;
}
// src/session/execution/session-control.ts
async function cancelSessionPrompt(options) {
	const cancelled = await tryCancelOnRunningOwner(options);
	return {
		sessionId: options.sessionId,
		cancelled: cancelled === true
	};
}
/**
* Dispatches the mode change to a running queue owner. Returns `undefined`
* when no owner holds the session, leaving the direct-connection decision to
* the caller.
*
* An owner advertising `persistsControlState` saves the accepted state itself.
* Only the older caller-save path still reloads and rewrites the record here,
* which is not serialized against another process doing the same.
*/
async function setSessionModeOnOwner(options) {
	const submittedToOwner = await trySetModeOnRunningOwner(options.sessionId, options.modeId, options.timeoutMs, options.verbose, options.assertDispatch);
	if (!submittedToOwner?.value) return;
	const record = await resolveSessionRecord(options.sessionId);
	if (!submittedToOwner.persistsControlState) {
		setDesiredModeId(record, options.modeId);
		await writeSessionRecord(record);
	}
	return {
		record,
		resumed: false
	};
}
async function setSessionMode(options) {
	const onOwner = await setSessionModeOnOwner(options);
	if (onOwner) return onOwner;
	return await runSessionSetModeDirect({
		sessionRecordId: options.sessionId,
		modeId: options.modeId,
		mcpServers: options.mcpServers,
		nonInteractivePermissions: options.nonInteractivePermissions,
		authCredentials: options.authCredentials,
		authPolicy: options.authPolicy,
		fs: options.fs,
		terminal: options.terminal,
		timeoutMs: options.timeoutMs,
		verbose: options.verbose
	});
}
/** Owner-only counterpart of {@link setSessionMode} for the model control. */
async function setSessionModelOnOwner(options) {
	const submittedToOwner = await trySetModelOnRunningOwner(options.sessionId, options.modelId, options.timeoutMs, options.verbose, options.assertDispatch);
	if (!submittedToOwner) return;
	const record = await resolveSessionRecord(options.sessionId);
	if (!submittedToOwner.persistsControlState) {
		record.acpx = applyModelSelection(record.acpx, options.modelId, submittedToOwner.value.response, resolveRequestedModelId({
			requestedModel: options.modelId,
			models: advertisedModelState(record.acpx),
			agentCommand: record.agentCommand
		}));
		await writeSessionRecord(record);
	}
	return {
		record,
		response: submittedToOwner.value.response,
		resumed: false
	};
}
async function setSessionModel(options) {
	const onOwner = await setSessionModelOnOwner(options);
	if (onOwner) return onOwner;
	return await runSessionSetModelDirect({
		sessionRecordId: options.sessionId,
		modelId: options.modelId,
		mcpServers: options.mcpServers,
		nonInteractivePermissions: options.nonInteractivePermissions,
		authCredentials: options.authCredentials,
		authPolicy: options.authPolicy,
		fs: options.fs,
		terminal: options.terminal,
		timeoutMs: options.timeoutMs,
		verbose: options.verbose
	});
}
/** Owner-only counterpart of {@link setSessionMode} for the config option control. */
async function setSessionConfigOptionOnOwner(options) {
	const ownerResponse = await trySetConfigOptionOnRunningOwner(options.sessionId, options.configId, options.value, options.timeoutMs, options.verbose, options.assertDispatch);
	if (!ownerResponse) return;
	const record = await resolveSessionRecord(options.sessionId);
	if (!ownerResponse.persistsControlState) {
		const models = advertisedModelState(record.acpx);
		const { modelConfigId, resolvedValue } = resolveRequestedConfigOption({
			configId: options.configId,
			value: options.value,
			models,
			agentCommand: record.agentCommand
		});
		record.acpx = applyConfigOptionSelection(record.acpx, options.configId, options.value, ownerResponse.value, modelConfigId, resolvedValue);
		await writeSessionRecord(record);
	}
	return {
		record,
		response: ownerResponse.value,
		resumed: false
	};
}
async function setSessionConfigOption(options) {
	const onOwner = await setSessionConfigOptionOnOwner(options);
	if (onOwner) return onOwner;
	return await runSessionSetConfigOptionDirect({
		sessionRecordId: options.sessionId,
		configId: options.configId,
		value: options.value,
		mcpServers: options.mcpServers,
		nonInteractivePermissions: options.nonInteractivePermissions,
		authCredentials: options.authCredentials,
		authPolicy: options.authPolicy,
		fs: options.fs,
		terminal: options.terminal,
		timeoutMs: options.timeoutMs,
		verbose: options.verbose
	});
}
function firstAgentCommandToken(command, argv) {
	if (argv) return argv[0] || void 0;
	try {
		return splitCommandLine(command).command || void 0;
	} catch {
		return;
	}
}
async function isLikelyMatchingProcess(pid, record) {
	const expectedToken = firstAgentCommandToken(record.agentCommand, record.agentArgv);
	if (!expectedToken) return false;
	const argv = await readProcessArgv(pid);
	if (argv.length === 0) return false;
	const executableBase = path.basename(argv[0]);
	const expectedBase = path.basename(expectedToken);
	return executableBase === expectedBase || argv.some((entry) => path.basename(entry) === expectedBase);
}
async function readProcessArgv(pid) {
	const procArgv = await readProcCmdline(pid);
	if (procArgv) return procArgv;
	return splitCommandLineLike(process.platform === "win32" ? await readWindowsCommandLine(pid) : await readPosixCommandLine(pid));
}
async function readProcCmdline(pid) {
	try {
		return (await fs$1.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
	} catch {
		return;
	}
}
async function readPosixCommandLine(pid) {
	try {
		return (await runTimedExecFile("ps", [
			"-p",
			String(pid),
			"-o",
			"command="
		])).trim() || void 0;
	} catch {
		return;
	}
}
async function readWindowsCommandLine(pid) {
	try {
		return (await runTimedExecFile("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`
		], { windowsHide: true })).replace(/\r?\n$/u, "") || void 0;
	} catch {
		return;
	}
}
function splitCommandLineLike(commandLine, platform = process.platform) {
	if (!commandLine) return [];
	if (platform === "win32") return splitWindowsProcessCommandLine(commandLine);
	try {
		const parsed = splitCommandLine(commandLine);
		return [parsed.command, ...parsed.args];
	} catch {
		return commandLine.split(/\s+/u).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
	}
}
const sessionControlTestInternals = {
	firstAgentCommandToken,
	splitCommandLineLike
};
async function closeSession(sessionId) {
	const record = await resolveSessionRecord(sessionId);
	let selectedOwner;
	await tryCloseSessionOnRunningOwner({
		sessionId: record.acpxRecordId,
		onOwnerSelected: (owner) => {
			selectedOwner = owner;
		}
	}).catch(() => {});
	if (selectedOwner) await terminateQueueOwnerForSession(record.acpxRecordId, selectedOwner);
	if (record.pid != null && isProcessAlive(record.pid) && await isLikelyMatchingProcess(record.pid, record)) await terminateProcess(record.pid);
	const ownership = await acquireSessionTurn(record.acpxRecordId);
	try {
		const current = await resolveSessionRecord(record.acpxRecordId);
		current.pid = void 0;
		current.closed = true;
		current.closedAt = isoNow$1();
		await writeSessionRecord(current);
		return current;
	} finally {
		await ownership[Symbol.asyncDispose]();
	}
}
// src/session/execution/session-management.ts
async function createSessionRecordWithClient(client, options, resumedRecordId) {
	const cwd = absolutePath(options.cwd);
	await withTimeout(client.start({ signal: options.signal }), options.timeoutMs);
	assertControlAuthority({ signal: options.signal });
	const createdState = options.resumeSessionId ? await resumeSessionRecordWithClient(client, options, cwd) : await createFreshSessionState(client, options, cwd);
	const { sessionId, agentSessionId } = createdState;
	assertControlAuthority({ signal: options.signal });
	const lifecycle = client.getAgentLifecycleSnapshot();
	const record = {
		...createInitialSessionRecord({
			recordId: resumedRecordId ?? randomUUID(),
			sessionId,
			agentSessionId,
			sessionOrigin: options.resumeSessionId ? "resume" : "new",
			agentCommand: options.agentCommand,
			agentArgv: options.agentArgv,
			cwd,
			name: normalizeName(options.name)
		}),
		lastRequestId: void 0,
		pid: lifecycle.running ? lifecycle.pid : void 0,
		agentStartedAt: lifecycle.startedAt,
		protocolVersion: client.initializeResult?.protocolVersion,
		agentCapabilities: client.initializeResult?.agentCapabilities
	};
	persistSessionOptions(record, options.sessionOptions);
	applyConfigOptionsToRecord(record, createdState.sessionResult);
	applyInitialModelSelection(record, createdState.sessionResult.models, createdState.modelApplication);
	await writeSessionRecord(record);
	assertControlAuthority({ signal: options.signal });
	return record;
}
async function createFreshSessionState(client, options, cwd) {
	const createdSession = await withTimeout(client.createSession(cwd, { signal: options.signal }), options.timeoutMs);
	assertControlAuthority({ signal: options.signal });
	const modelApplication = await applyRequestedModelIfAdvertised({
		client,
		sessionId: createdSession.sessionId,
		requestedModel: options.sessionOptions?.model,
		models: createdSession.models,
		agentCommand: options.agentCommand,
		timeoutMs: options.timeoutMs,
		onWarning: options.onModelWarning,
		authority: { signal: options.signal }
	});
	return {
		sessionId: createdSession.sessionId,
		agentSessionId: normalizeAgentSessionId(createdSession.agentSessionId),
		sessionResult: createdSession,
		modelApplication
	};
}
async function resumeSessionRecordWithClient(client, options, cwd) {
	if (!options.resumeSessionId) throw new Error("resumeSessionId is required");
	const resumeMethod = client.supportsResumeSession() ? "session/resume" : client.supportsLoadSession() ? "session/load" : void 0;
	if (!resumeMethod) throw new Error(`Agent command "${options.agentCommand}" does not support session/resume or session/load; cannot resume session ${options.resumeSessionId}`);
	try {
		const resumedSession = await withTimeout(resumeMethod === "session/resume" ? client.resumeSession(options.resumeSessionId, cwd, { signal: options.signal }) : client.loadSessionWithOptions(options.resumeSessionId, cwd, { authority: { signal: options.signal } }), options.timeoutMs);
		const sessionModels = resumedSession.models;
		assertControlAuthority({ signal: options.signal });
		const modelApplication = await applyRequestedModelIfAdvertised({
			client,
			sessionId: options.resumeSessionId,
			requestedModel: options.sessionOptions?.model,
			models: sessionModels,
			agentCommand: options.agentCommand,
			timeoutMs: options.timeoutMs,
			onWarning: options.onModelWarning,
			authority: { signal: options.signal }
		});
		return {
			sessionId: options.resumeSessionId,
			agentSessionId: normalizeAgentSessionId(resumedSession.agentSessionId),
			sessionResult: resumedSession,
			modelApplication
		};
	} catch (error) {
		throw new Error(`Failed to resume ACP session ${options.resumeSessionId}: ${formatErrorMessage(error)}`, { cause: error });
	}
}
async function createSessionWithClient(options) {
	assertControlAuthority({ signal: options.signal });
	let resumedRecordId;
	if (options.resumeSessionId) {
		const resumedRecord = await readSessionRecord(options.resumeSessionId);
		assertControlAuthority({ signal: options.signal });
		if (resumedRecord && resumedRecord.agentCommand === options.agentCommand) {
			resumedRecordId = resumedRecord.acpxRecordId;
			if (!resumedRecord.closed) await closeSession(resumedRecord.acpxRecordId);
			options = {
				...options,
				resumeSessionId: resumedRecord.acpSessionId
			};
			assertControlAuthority({ signal: options.signal });
		}
	}
	const client = new AcpClient({
		agentCommand: options.agentCommand,
		agentArgv: options.agentArgv,
		cwd: absolutePath(options.cwd),
		mcpServers: options.mcpServers,
		permissionMode: options.permissionMode,
		nonInteractivePermissions: options.nonInteractivePermissions,
		permissionPolicy: options.permissionPolicy,
		authCredentials: options.authCredentials,
		authPolicy: options.authPolicy,
		fs: options.fs,
		terminal: options.terminal,
		verbose: options.verbose,
		sessionOptions: options.sessionOptions
	});
	const closeOwnedClient = ownDirectClient(client, options.signal);
	try {
		const create = async () => {
			assertControlAuthority({ signal: options.signal });
			const record = await createSessionRecordWithClient(client, options, resumedRecordId);
			assertControlAuthority({ signal: options.signal });
			return record;
		};
		return {
			record: options.handleProcessInterrupts === false ? await create() : await withInterrupt(create, async () => {
				await closeOwnedClient();
			}),
			client
		};
	} catch (error) {
		await closeOwnedClient();
		throw directExecutionError(error, options.signal);
	} finally {
		closeOwnedClient.release();
	}
}
async function createSession(options) {
	const { record, client } = await createSessionWithClient(options);
	try {
		return record;
	} finally {
		await client.close();
		applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
		await writeSessionRecord(record);
	}
}
async function listAgentSessions(options) {
	const client = new AcpClient({
		agentCommand: options.agentCommand,
		agentArgv: options.agentArgv,
		cwd: absolutePath(options.cwd),
		mcpServers: options.mcpServers,
		permissionMode: options.permissionMode,
		nonInteractivePermissions: options.nonInteractivePermissions,
		permissionPolicy: options.permissionPolicy,
		authCredentials: options.authCredentials,
		authPolicy: options.authPolicy,
		fs: options.fs,
		terminal: options.terminal,
		verbose: options.verbose
	});
	try {
		return await withInterrupt(async () => {
			await withTimeout(client.start(), options.timeoutMs);
			if (!client.supportsListSessions()) return;
			const cwd = options.filterCwd ? absolutePath(options.filterCwd) : void 0;
			const response = await withTimeout(client.listSessions({
				...cwd ? { cwd } : {},
				...options.cursor ? { cursor: options.cursor } : {}
			}), options.timeoutMs);
			return {
				_meta: response._meta,
				source: "agent",
				sessions: response.sessions,
				cursor: options.cursor,
				cwd,
				nextCursor: response.nextCursor
			};
		}, async () => {
			await client.close();
		});
	} finally {
		await client.close();
	}
}
async function ensureSession(options) {
	const cwd = absolutePath(options.cwd);
	const ownership = await acquireSessionScope({
		agentCommand: options.agentCommand,
		cwd,
		name: normalizeName(options.name)
	}, options.signal);
	try {
		return await ensureSessionWithOwnership(options, cwd);
	} finally {
		await ownership[Symbol.asyncDispose]();
	}
}
async function ensureSessionWithOwnership(options, cwd) {
	assertControlAuthority({ signal: options.signal });
	const gitRoot = findGitRepositoryRoot(cwd);
	const walkBoundary = options.walkBoundary ?? gitRoot ?? cwd;
	const existing = await findSessionByDirectoryWalk({
		agentCommand: options.agentCommand,
		cwd,
		name: options.name,
		boundary: walkBoundary
	});
	if (existing) {
		const requestedModel = options.sessionOptions?.model;
		if (requestedModel) return {
			record: (await setSessionModel({
				sessionId: existing.acpxRecordId,
				modelId: requestedModel,
				mcpServers: options.mcpServers,
				nonInteractivePermissions: options.nonInteractivePermissions,
				authCredentials: options.authCredentials,
				authPolicy: options.authPolicy,
				fs: options.fs,
				terminal: options.terminal,
				timeoutMs: options.timeoutMs,
				verbose: options.verbose
			})).record,
			created: false
		};
		return {
			record: existing,
			created: false
		};
	}
	return {
		record: await createSession({
			signal: options.signal,
			handleProcessInterrupts: options.handleProcessInterrupts,
			agentCommand: options.agentCommand,
			agentArgv: options.agentArgv,
			cwd,
			name: options.name,
			resumeSessionId: options.resumeSessionId,
			mcpServers: options.mcpServers,
			permissionMode: options.permissionMode,
			nonInteractivePermissions: options.nonInteractivePermissions,
			permissionPolicy: options.permissionPolicy,
			authCredentials: options.authCredentials,
			authPolicy: options.authPolicy,
			fs: options.fs,
			terminal: options.terminal,
			timeoutMs: options.timeoutMs,
			verbose: options.verbose,
			sessionOptions: options.sessionOptions
		}),
		created: true
	};
}
// src/perf-metrics-capture.ts
const PERF_METRICS_FILE_ENV = "ACPX_PERF_METRICS_FILE";
let installed = false;
let flushed = false;
let captureFilePath;
let captureRole = "cli";
let captureArgv = [];
let captureSequence = 0;
function shouldCapture() {
	return typeof captureFilePath === "string" && captureFilePath.trim().length > 0;
}
function buildPayload(reason) {
	return {
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		pid: process.pid,
		ppid: process.ppid,
		role: captureRole,
		argv: captureArgv,
		cwd: process.cwd(),
		sequence: captureSequence,
		reason,
		metrics: getPerfMetricsSnapshot()
	};
}
function payloadHasMetrics(payload) {
	const metrics = payload.metrics;
	return [
		metrics.counters,
		metrics.gauges,
		metrics.timings
	].some((entries) => Object.keys(entries ?? {}).length > 0);
}
function appendPerfMetricsPayload(payload) {
	fs.mkdirSync(path.dirname(captureFilePath), { recursive: true });
	appendRegularFileSync({
		filePath: captureFilePath,
		content: `${JSON.stringify(payload)}\n`,
		mode: 384
	});
	captureSequence += 1;
}
function writePerfMetricsCapture(reason, resetAfterWrite) {
	if (!shouldCapture()) return false;
	const payload = buildPayload(reason);
	if (!payloadHasMetrics(payload)) return false;
	try {
		appendPerfMetricsPayload(payload);
		if (resetAfterWrite) resetPerfMetrics();
		return true;
	} catch {
		return false;
	}
}
function checkpointPerfMetricsCapture() {
	flushed = false;
	writePerfMetricsCapture("checkpoint", true);
}
function flushPerfMetricsCapture(reason = "exit") {
	if (flushed || !shouldCapture()) return;
	flushed = true;
	writePerfMetricsCapture(reason, false);
}
function installPerfMetricsCapture(options = {}) {
	captureFilePath = options.filePath ?? process.env[PERF_METRICS_FILE_ENV];
	if (!shouldCapture()) return;
	resetPerfMetrics();
	captureRole = options.role ?? captureRole;
	captureArgv = options.argv ?? [];
	captureSequence = 0;
	flushed = false;
	if (installed) return;
	installed = true;
	process.once("exit", () => {
		flushPerfMetricsCapture("exit");
	});
	for (const signal of ["SIGINT", "SIGTERM"]) {
		const handler = () => {
			flushPerfMetricsCapture("signal");
			process.removeListener(signal, handler);
			process.kill(process.pid, signal);
		};
		process.once(signal, handler);
	}
}
// src/session/queue/control-admission.ts
var QueueControlDeadline = class {
	controller = new AbortController();
	admissionSignal;
	expiresAt;
	expired;
	timeoutError;
	rejectExpiry;
	timer;
	nativeSettled = false;
	admitted = false;
	constructor(timeoutMs, ownerSignal) {
		this.admissionSignal = ownerSignal ? AbortSignal.any([this.controller.signal, ownerSignal]) : this.controller.signal;
		this.expiresAt = timeoutMs != null && timeoutMs > 0 ? performance.now() + timeoutMs : void 0;
		this.timeoutError = this.expiresAt === void 0 ? void 0 : new TimeoutError(timeoutMs);
		this.expired = new Promise((_resolve, reject) => {
			this.rejectExpiry = reject;
			if (this.expiresAt !== void 0) this.timer = setTimeout(() => this.expire(), timeoutMs);
		});
		this.expired.catch(() => {});
	}
	get signal() {
		return this.admissionSignal;
	}
	get timeoutSignal() {
		return this.controller.signal;
	}
	get remainingMs() {
		this.assertActive();
		return this.expiresAt === void 0 || this.nativeSettled ? void 0 : Math.max(1, this.expiresAt - performance.now());
	}
	get nativeAdmitted() {
		return this.admitted;
	}
	get authority() {
		return {
			signal: this.signal,
			assertActive: () => {
				this.assertActive();
				this.admitted = true;
			}
		};
	}
	assertActive() {
		if (this.expiresAt !== void 0 && performance.now() >= this.expiresAt) this.expire();
		this.signal.throwIfAborted();
	}
	expire() {
		if (this.nativeSettled || this.timeoutSignal.aborted || !this.timeoutError) return;
		this.controller.abort(this.timeoutError);
		this.rejectExpiry(this.timeoutError);
	}
	responseSettled() {
		this.nativeSettled = true;
		clearTimeout(this.timer);
		this.timer = void 0;
	}
	isExpired(error) {
		return this.timeoutSignal.aborted && error === this.timeoutSignal.reason;
	}
	async wait(operation) {
		return await Promise.race([operation, this.expired]);
	}
};
function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((accept, fail) => {
		resolve = accept;
		reject = fail;
	});
	promise.catch(() => {});
	return {
		promise,
		resolve,
		reject
	};
}
function drained(operation) {
	return operation.then(() => {}, () => {});
}
var QueueOwnerControlAdmission = class {
	options;
	idleTail = Promise.resolve();
	ticket;
	stopped = new AbortController();
	pending = 0;
	constructor(options) {
		this.options = options;
	}
	get hasPending() {
		return this.pending > 0;
	}
	beginPrompt() {
		const ticket = {
			ready: deferred(),
			released: deferred(),
			rawTail: Promise.resolve(),
			sealed: false
		};
		this.ticket = ticket;
		return {
			ticket,
			priorIdle: this.idleTail
		};
	}
	publish(ticket, controls) {
		if (!ticket.sealed) ticket.ready.resolve(controls);
	}
	seal(ticket) {
		ticket.sealed = true;
		ticket.ready.reject(new QueueConnectionError("Prompt ended before controls became ready", {
			detailCode: "QUEUE_CONTROL_REQUEST_FAILED",
			origin: "queue",
			retryable: true
		}));
		return ticket.rawTail;
	}
	release(ticket) {
		if (this.ticket === ticket) this.ticket = void 0;
		ticket.released.resolve();
	}
	stopAdmission() {
		this.stopped.abort(new QueueConnectionError("Queue owner is closing", {
			detailCode: "QUEUE_OWNER_SHUTTING_DOWN",
			origin: "queue",
			retryable: true
		}));
	}
	async drainAdmitted() {
		await Promise.all([this.idleTail, this.ticket?.rawTail]);
	}
	async run(invoke, timeoutMs, replacingConfigOption) {
		const deadline = new QueueControlDeadline(timeoutMs, this.stopped.signal);
		this.pending += 1;
		const operation = this.enqueue(invoke, {
			deadline,
			replacingConfigOption
		});
		operation.finally(() => {
			this.pending -= 1;
			deadline.responseSettled();
		}).catch(() => {});
		return await deadline.wait(operation);
	}
	async enqueue(invoke, options) {
		options.deadline.assertActive();
		const ticket = this.ticket;
		if (ticket?.sealed) return ticket.released.promise.then(() => this.enqueue(invoke, options));
		if (ticket) {
			const operation = ticket.rawTail.then(async () => {
				const controls = await ticket.ready.promise.catch((error) => {
					options.deadline.assertActive();
					throw error;
				});
				options.deadline.assertActive();
				return await invoke(controls, options.deadline);
			});
			ticket.rawTail = drained(operation);
			return operation;
		}
		const operation = this.idleTail.then(async () => {
			options.deadline.assertActive();
			return await this.options.runIdle(invoke, options);
		});
		this.idleTail = drained(operation);
		return operation;
	}
};
// src/session/queue/owner-turn-controller.ts
var QueueOwnerTurnController = class {
	state = "idle";
	pendingCancel = false;
	activeController;
	waitingTurn;
	get lifecycleState() {
		return this.state;
	}
	get hasPendingCancel() {
		return this.pendingCancel;
	}
	beginTurn() {
		this.state = "starting";
		this.pendingCancel = false;
		this.waitingTurn = new AbortController();
		return this.waitingTurn.signal;
	}
	markPromptActive() {
		if (this.state === "starting" || this.state === "active") this.state = "active";
	}
	endTurn() {
		this.state = "idle";
		this.pendingCancel = false;
		this.waitingTurn = void 0;
	}
	beginClosing() {
		this.state = "closing";
		this.pendingCancel = false;
		this.activeController = void 0;
	}
	setActiveController(controller) {
		this.activeController = controller;
	}
	clearActiveController() {
		this.activeController = void 0;
	}
	async requestCancel() {
		const activeController = this.activeController;
		if (activeController?.hasActivePrompt()) return await this.cancelActivePrompt(activeController);
		if (this.state === "starting" || this.state === "active") {
			this.pendingCancel = true;
			this.waitingTurn?.abort();
			return true;
		}
		return false;
	}
	async applyPendingCancel() {
		const activeController = this.activeController;
		if (!this.pendingCancel || !activeController || !activeController.hasActivePrompt()) return false;
		return await this.cancelActivePrompt(activeController);
	}
	async cancelActivePrompt(activeController) {
		const turn = this.waitingTurn;
		const cancellation = activeController.requestCancelActivePrompt();
		turn?.abort();
		const cancelled = await cancellation;
		if (cancelled && this.waitingTurn === turn) this.pendingCancel = false;
		return cancelled;
	}
};
// src/session/execution/owned-controls.ts
async function acceptControl(options, invoke, apply, deadline = new QueueControlDeadline()) {
	deadline.assertActive();
	const raw = invoke(deadline.authority).then(async (response) => {
		deadline.responseSettled();
		apply(response);
		await options.checkpoint();
		return response;
	}, (error) => {
		deadline.responseSettled();
		throw error;
	});
	try {
		return await deadline.wait(raw);
	} catch (error) {
		if (deadline.isExpired(error) && deadline.nativeAdmitted) {
			const [retired] = await Promise.allSettled([options.retire(), raw]);
			if (retired.status === "rejected") throw retired.reason;
		}
		throw error;
	}
}
function createOwnedSessionControls(options) {
	return {
		setSessionMode: async (modeId, deadline) => {
			await acceptControl(options, (authority) => options.client.setSessionMode(options.sessionId(), modeId, authority), () => setDesiredModeId(options.record, modeId), deadline);
		},
		setSessionModel: async (modelId, deadline) => {
			const models = advertisedModelState(options.record.acpx);
			const resolvedModelId = resolveRequestedModelId({
				requestedModel: modelId,
				models,
				agentCommand: options.record.agentCommand
			});
			return await acceptControl(options, (authority) => options.client.setSessionModel(options.sessionId(), modelId, models, authority), (response) => {
				options.record.acpx = applyModelSelection(options.record.acpx, modelId, response, resolvedModelId);
			}, deadline);
		},
		setSessionConfigOption: async (configId, value, deadline) => {
			const models = advertisedModelState(options.record.acpx);
			const { modelConfigId, resolvedValue } = resolveRequestedConfigOption({
				configId,
				value,
				models,
				agentCommand: options.record.agentCommand
			});
			return await acceptControl(options, (authority) => options.client.setSessionConfigOption(options.sessionId(), configId, value, models, authority), (response) => {
				options.record.acpx = applyConfigOptionSelection(options.record.acpx, configId, value, response, modelConfigId, resolvedValue);
			}, deadline);
		}
	};
}
async function runIdleControlWithRecord(options, record, invoke) {
	const { client, deadline } = options;
	deadline.assertActive();
	let retirement;
	const retire = () => {
		retirement ??= client.close().catch((error) => {
			options.onRetirementFailure();
			throw error;
		});
		return retirement;
	};
	const onAbort = () => {
		retire().catch(() => {});
	};
	const checkpoint = async () => {
		record.lastUsedAt = isoNow$1();
		applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
		await writeSessionRecord(record);
	};
	let sessionId = record.acpSessionId;
	const controls = createOwnedSessionControls({
		client,
		record,
		sessionId: () => sessionId,
		checkpoint,
		retire
	});
	client.setEventHandlers({ onSessionUpdate: (notification) => {
		record.acpx = recordSessionUpdate(record, record.acpx, notification);
	} });
	deadline.timeoutSignal.addEventListener("abort", onAbort, { once: true });
	let connected = false;
	let completed = false;
	try {
		await connectAndLoadSession({
			client,
			record,
			resumePolicy: "same-session-only",
			replacingConfigOption: options.replacingConfigOption,
			timeoutMs: deadline.remainingMs,
			authority: deadline.authority,
			verbose: options.verbose,
			activeController: {
				...controls,
				hasActivePrompt: () => client.hasActivePrompt(),
				requestCancelActivePrompt: () => client.requestCancelActivePrompt()
			},
			onSessionIdResolved: (value) => {
				sessionId = value;
			}
		});
		connected = true;
		deadline.assertActive();
		const value = await invoke(controls, deadline);
		completed = true;
		return value;
	} finally {
		deadline.timeoutSignal.removeEventListener("abort", onAbort);
		try {
			if (!connected) await retire();
			await retirement;
			if (!completed || retirement) await checkpoint().catch(() => {});
		} finally {
			client.clearEventHandlers();
		}
	}
}
async function runIdleOwnerControl(options, invoke) {
	const { acpxRecordId } = await resolveSessionRecord(options.sessionId);
	const ownership = await acquireSessionTurn(acpxRecordId, options.deadline.signal).catch((error) => {
		options.deadline.assertActive();
		throw error;
	});
	try {
		return await runIdleControlWithRecord(options, await resolveSessionRecord(acpxRecordId), invoke);
	} finally {
		await ownership[Symbol.asyncDispose]();
	}
}
// src/session/execution/queue-owner-process.ts
function isNonEmptyStringArray(value) {
	return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.length > 0);
}
const NODE_TEST_FLAGS = /* @__PURE__ */ new Set([
	"--experimental-test-coverage",
	"--test",
	"--test-name-pattern",
	"--test-reporter",
	"--test-reporter-destination"
]);
const NODE_TEST_FLAGS_WITH_VALUE = /* @__PURE__ */ new Set([
	"--test-name-pattern",
	"--test-reporter",
	"--test-reporter-destination"
]);
const INSPECTOR_FLAGS = /* @__PURE__ */ new Set([
	"--inspect",
	"--inspect-brk",
	"--inspect-wait"
]);
const INSPECTOR_FLAGS_WITH_VALUE = /* @__PURE__ */ new Set([
	"--inspect-port",
	"--inspect-publish-uid",
	"--debug-port"
]);
function classifyExecArgv(value) {
	if (NODE_TEST_FLAGS_WITH_VALUE.has(value)) return "drop-with-value";
	if (NODE_TEST_FLAGS.has(value) || value.startsWith("--test-")) return "drop";
	return classifyInspectorArgv(value);
}
function classifyInspectorArgv(value) {
	const [name] = value.split("=", 1);
	if (!name?.startsWith("--")) return "keep";
	const flag = name.replaceAll("_", "-");
	if (INSPECTOR_FLAGS_WITH_VALUE.has(flag)) return value.includes("=") ? "drop" : "drop-with-value";
	return INSPECTOR_FLAGS.has(flag) ? "drop" : "keep";
}
function sanitizeQueueOwnerExecArgv(execArgv = process.execArgv) {
	const sanitized = [];
	for (let index = 0; index < execArgv.length; index += 1) {
		const value = execArgv[index] ?? "";
		const decision = classifyExecArgv(value);
		if (decision === "drop") continue;
		if (decision === "drop-with-value") {
			index += 1;
			continue;
		}
		sanitized.push(value);
	}
	return sanitized;
}
function buildQueueOwnerArgOverride(entryPath, execArgv = process.execArgv) {
	const sanitized = sanitizeQueueOwnerExecArgv(execArgv);
	if (sanitized.length === 0) return null;
	return JSON.stringify([
		...sanitized,
		entryPath,
		"__queue-owner"
	]);
}
function resolveQueueOwnerSpawnArgs(argv = process.argv) {
	const override = process.env.ACPX_QUEUE_OWNER_ARGS;
	if (override) {
		const parsed = JSON.parse(override);
		if (isNonEmptyStringArray(parsed)) return [...parsed];
		throw new Error("acpx self-spawn failed: invalid ACPX_QUEUE_OWNER_ARGS");
	}
	const entry = argv[1];
	if (!entry || entry.trim().length === 0) throw new Error("acpx self-spawn failed: missing CLI entry path");
	return [realpathSync(entry), "__queue-owner"];
}
function queueOwnerRuntimeOptionsFromSend(options) {
	return {
		sessionId: options.sessionId,
		mcpServers: options.mcpServers,
		...options.mcpConfigPath ? { mcpConfigPath: options.mcpConfigPath } : {},
		...options.mcpConfigFingerprint ? { mcpConfigFingerprint: options.mcpConfigFingerprint } : {},
		permissionMode: options.permissionMode,
		nonInteractivePermissions: options.nonInteractivePermissions,
		authCredentials: options.authCredentials,
		authPolicy: options.authPolicy,
		fs: options.fs,
		terminal: options.terminal,
		suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
		verbose: options.verbose,
		ttlMs: options.ttlMs,
		maxQueueDepth: options.maxQueueDepth,
		promptRetries: options.promptRetries,
		sessionOptions: options.sessionOptions
	};
}
/** Max stderr bytes retained for cold-start diagnostics. */
const QUEUE_OWNER_STARTUP_STDERR_MAX_BYTES = 4e3;
function formatQueueOwnerStartupFailure(params) {
	const parts = [`Session queue owner failed to start for session ${params.sessionId}`];
	if (params.exit.spawnError) parts.push(`spawn error: ${params.exit.spawnError.message}`);
	else if (params.exit.exited) {
		const codePart = params.exit.code === null ? "null" : String(params.exit.code);
		const signalPart = params.exit.signal ? `, signal ${params.exit.signal}` : "";
		parts.push(`exited with code ${codePart}${signalPart} before binding its socket`);
	}
	if (params.exit.inputError) parts.push(`startup input failed: ${params.exit.inputError.message}`);
	const tail = params.logTail.trim();
	if (tail.length > 0) parts.push(`stderr:\n${tail}`);
	return parts.join(": ");
}
function spawnQueueOwnerProcess(options, queueOwnerArgs) {
	const payload = JSON.stringify(options);
	let exited = false;
	let code = null;
	let signal = null;
	let spawnError;
	let inputError;
	let capturing = true;
	let stderrTail = Buffer.alloc(0);
	const child = spawn(process.execPath, queueOwnerArgs ?? resolveQueueOwnerSpawnArgs(), {
		detached: true,
		stdio: [
			"pipe",
			"ignore",
			"pipe"
		],
		windowsHide: true
	});
	child.stdin.on("error", (error) => {
		inputError = error;
	});
	child.stdin.end(payload);
	const stopStartupCapture = () => {
		if (!capturing) return;
		capturing = false;
		const stderr = child.stderr;
		if (!stderr) return;
		stderr.removeAllListeners("data");
		stderr.on("data", () => {});
		stderr.resume();
		stderr.unref();
	};
	child.stderr?.on("data", (chunk) => {
		if (!capturing) return;
		const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		const combined = Buffer.concat([stderrTail, buf]);
		stderrTail = combined.length > 4e3 ? combined.subarray(combined.length - QUEUE_OWNER_STARTUP_STDERR_MAX_BYTES) : combined;
	});
	child.stderr?.on("error", () => {});
	child.on("error", (error) => {
		spawnError = error;
	});
	child.on("close", (exitCode, exitSignal) => {
		exited = true;
		code = exitCode;
		signal = exitSignal;
		stopStartupCapture();
	});
	child.unref();
	return {
		pid: child.pid,
		getExitState: () => ({
			exited,
			code,
			signal,
			...spawnError ? { spawnError } : {},
			...inputError ? { inputError } : {}
		}),
		readLogTail: (maxBytes = QUEUE_OWNER_STARTUP_STDERR_MAX_BYTES) => {
			const start = Math.max(0, stderrTail.length - maxBytes);
			return stderrTail.subarray(start).toString("utf8");
		},
		stopStartupCapture
	};
}
// src/runtime/engine/prompt-turn.ts
const SESSION_REPLY_IDLE_MS = 1e3;
const SESSION_REPLY_DRAIN_TIMEOUT_MS = 5e3;
function responseMetaField(meta) {
	return meta === void 0 ? {} : { _meta: meta };
}
function recoveredSessionResult(response, conversation, promptMessageId) {
	recordPromptResponseUsage(conversation, response.usage, promptMessageId);
	return {
		stopReason: response.stopReason,
		source: "session",
		...responseMetaField(response._meta)
	};
}
function abortTimedOutRequests(error, lifetime) {
	if (error instanceof TimeoutError) lifetime.abort(error);
}
function promptRequestAuthority(lifetime, authority) {
	return {
		signal: authority?.signal ? AbortSignal.any([authority.signal, lifetime.signal]) : lifetime.signal,
		assertActive: () => assertControlAuthority(authority)
	};
}
async function runPromptTurn(params) {
	let settledResponse;
	const lifetime = new AbortController();
	try {
		const promptPromise = params.client.prompt(params.sessionId, params.prompt, params.onPromptRequestWritten, params.onElicitation, params.onPermissionRequest, promptRequestAuthority(lifetime, params.authority));
		promptPromise.then((response) => {
			settledResponse = response;
		}, () => {});
		await params.onPromptStarted?.();
		const response = await withTimeout(promptPromise, params.timeoutMs);
		await params.client.waitForSessionUpdatesIdle?.({
			idleMs: SESSION_REPLY_IDLE_MS,
			timeoutMs: SESSION_REPLY_DRAIN_TIMEOUT_MS
		}).catch(() => {});
		recordPromptResponseUsage(params.conversation, response.usage, params.promptMessageId);
		return {
			stopReason: response.stopReason,
			source: "rpc",
			...responseMetaField(response._meta)
		};
	} catch (error) {
		abortTimedOutRequests(error, lifetime);
		if (!(error instanceof TimeoutError) || !params.promptMessageId) throw error;
		await params.client.waitForSessionUpdatesIdle?.({
			idleMs: SESSION_REPLY_IDLE_MS,
			timeoutMs: SESSION_REPLY_DRAIN_TIMEOUT_MS
		}).catch(() => {});
		if (settledResponse) return recoveredSessionResult(settledResponse, params.conversation, params.promptMessageId);
		throw error;
	} finally {
		lifetime.abort();
	}
}
// src/session/live-checkpoint.ts
const DEFAULT_LIVE_CHECKPOINT_INTERVAL_MS = 500;
var LiveSessionCheckpoint = class {
	save;
	intervalMs;
	onError;
	dirty = false;
	flushing;
	timer;
	constructor(options) {
		this.save = options.save;
		this.intervalMs = options.intervalMs ?? DEFAULT_LIVE_CHECKPOINT_INTERVAL_MS;
		this.onError = options.onError;
	}
	request() {
		this.dirty = true;
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = void 0;
			this.flush().catch((error) => {
				this.onError?.(error);
			});
		}, this.intervalMs);
		this.timer.unref?.();
	}
	async checkpoint() {
		this.dirty = true;
		await this.flush();
	}
	async flush() {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = void 0;
		}
		// A materialization waiter can acquire the writer before a flush resumes.
		while (this.flushing) {
			await this.flushing;
			if (!this.dirty) return;
		}
		this.flushing = this.flushDirty();
		try {
			await this.flushing;
		} finally {
			this.flushing = void 0;
		}
	}
	async runMaterializationExclusive(operation) {
		while (this.flushing) await this.flushing.catch(() => {});
		const running = operation();
		this.flushing = running.then(() => {}, () => {});
		try {
			return await running;
		} finally {
			this.flushing = void 0;
		}
	}
	async flushDirty() {
		while (this.dirty) {
			this.dirty = false;
			try {
				await this.save();
			} catch (error) {
				this.dirty = true;
				throw error;
			}
		}
	}
};
// src/session/execution/discard-output.ts
const DISCARD_OUTPUT_FORMATTER = {
	setContext() {},
	onAcpMessage() {},
	onError() {},
	onPermissionEscalation() {},
	flush() {}
};
// src/session/execution/runtime.ts
const INTERRUPT_CANCEL_WAIT_MS = 2500;
var QueueTaskOutputFormatter = class {
	requestId;
	send;
	constructor(task) {
		this.requestId = task.requestId;
		this.send = task.send;
	}
	setContext(_context) {}
	onAcpMessage(message, direction) {
		this.send({
			type: "event",
			requestId: this.requestId,
			...direction === void 0 ? {} : { direction },
			message
		});
	}
	onError(params) {
		this.send({
			type: "error",
			requestId: this.requestId,
			code: params.code,
			detailCode: params.detailCode,
			origin: params.origin,
			message: params.message,
			retryable: params.retryable,
			acp: params.acp
		});
	}
	onPermissionEscalation(event) {
		this.send({
			type: "permission_escalation",
			requestId: this.requestId,
			event
		});
	}
	flush() {}
};
function markOutputAlreadyEmitted(error, outputAlreadyEmitted) {
	if (!error || typeof error !== "object") return;
	error.outputAlreadyEmitted = outputAlreadyEmitted;
}
async function runWithOptionalInterrupt(options) {
	if (options.handleProcessInterrupts === false) return await options.run();
	return await withInterrupt(options.run, options.handleInterrupt);
}
function attachAcpErrorPayload(error, acp) {
	if (!acp || !error || typeof error !== "object") return;
	error.acp = acp;
}
function rendersAcpErrors(policy) {
	return policy?.queueErrorAlreadyEmitted ?? true;
}
function normalizedErrorText(value) {
	return value.trim().toLowerCase();
}
function outboundAcpErrorMatches(error, acp) {
	const errorText = normalizedErrorText(formatErrorMessage(error));
	const details = acp.data?.details;
	const candidateText = normalizedErrorText(typeof details === "string" && details.trim().length > 0 ? details : acp.message);
	return errorText === candidateText || errorText.includes(candidateText);
}
var AcpErrorTracker = class {
	latestInbound;
	outbound = [];
	reset() {
		this.latestInbound = void 0;
		this.outbound.length = 0;
	}
	observe(output, direction, message) {
		output.onAcpMessage(message, direction);
		const acp = extractAcpError(message);
		if (!acp) return;
		if (direction === "inbound") {
			this.latestInbound = acp;
			return;
		}
		this.outbound.push(acp);
	}
	match(error) {
		return this.latestInbound ?? this.outbound.findLast((acp) => outboundAcpErrorMatches(error, acp));
	}
};
function toPromptResult(stopReason, sessionId, client, before, meta) {
	const after = client.getPermissionStats();
	return {
		stopReason,
		sessionId,
		permissionStats: {
			requested: after.requested - before.requested,
			approved: after.approved - before.approved,
			denied: after.denied - before.denied,
			cancelled: after.cancelled - before.cancelled
		},
		...meta === void 0 ? {} : { _meta: meta }
	};
}
function requestedModelId(value) {
	return typeof value === "string" ? value.trim() : "";
}
async function applyPromptModelIfAdvertised(params) {
	const requestedModel = requestedModelId(params.requestedModel);
	if (!requestedModel) return;
	const result = await applyRequestedModelIfAdvertised({
		client: params.client,
		sessionId: params.sessionId,
		requestedModel,
		models: advertisedModelState(params.record.acpx),
		agentCommand: params.record.agentCommand,
		timeoutMs: params.timeoutMs,
		authority: { signal: params.signal },
		onWarning: params.suppressWarnings ? void 0 : (message) => process.stderr.write(`[acpx] warning: ${message}\n`)
	});
	if (result.applied) params.record.acpx = applyModelSelection(params.record.acpx, requestedModel, result.response, result.resolvedModelId);
}
function jsonRpcIdKey(message) {
	if (!("id" in message)) return;
	const value = message.id;
	if (typeof value === "string") return `s:${value}`;
	if (typeof value === "number" && Number.isFinite(value)) return `n:${value}`;
}
const SESSION_RECONNECT_METHODS = /* @__PURE__ */ new Set(["session/load", "session/resume"]);
function isReconnectRequest(direction, message) {
	return direction === "outbound" && "method" in message && typeof message.method === "string" && SESSION_RECONNECT_METHODS.has(message.method);
}
function isInboundResponse(direction, message) {
	return direction === "inbound" && ("result" in message || "error" in message);
}
function filterBufferedConnectOutput(messages, loadError) {
	if (loadError == null) return messages;
	const pending = /* @__PURE__ */ new Map();
	const suppressed = /* @__PURE__ */ new Set();
	for (const [index, { direction, message }] of messages.entries()) {
		const id = jsonRpcIdKey(message);
		if (!id) continue;
		if (isReconnectRequest(direction, message)) pending.set(id, index);
		else if (isInboundResponse(direction, message)) {
			const requestIndex = pending.get(id);
			if (requestIndex !== void 0 && "error" in message) {
				suppressed.add(requestIndex);
				suppressed.add(index);
			}
			pending.delete(id);
		}
	}
	return messages.filter((_message, index) => !suppressed.has(index));
}
function emitPromptRetryNotice(params) {
	if (params.suppressSdkConsoleErrors) return;
	process.stderr.write(`[acpx] prompt failed (${formatErrorMessage(params.error)}), retrying in ${params.delayMs}ms (attempt ${params.attempt}/${params.maxRetries})\n`);
}
function emitConnectPerfMetric(startedAt, verbose) {
	if (!verbose) return;
	process.stderr.write(`[acpx] ${formatPerfMetric("prompt.connect_and_load", Date.now() - startedAt)}\n`);
}
function emitPromptPerfMetric(startedAt, verbose) {
	if (!verbose) return;
	process.stderr.write(`[acpx] ${formatPerfMetric("prompt.agent_turn", Date.now() - startedAt)}\n`);
}
function emitPromptHookError(error, verbose) {
	if (!verbose) return;
	process.stderr.write("[acpx] onPromptActive hook failed: " + formatErrorMessage(error) + "\n");
}
function emitPromptDisconnectNotice(snapshot, verbose) {
	const lastExit = snapshot.lastExit;
	if (!lastExit?.unexpectedDuringPrompt || !verbose) return;
	process.stderr.write("[acpx] agent disconnected during prompt (" + lastExit.reason + ", exit=" + lastExit.exitCode + ", signal=" + (lastExit.signal ?? "none") + ")\n");
}
async function preparePromptRetry(error, attempt, maxRetries, hasSideEffects, suppressSdkConsoleErrors, signal) {
	if (attempt < maxRetries && !hasSideEffects() && isRetryablePromptError(error)) {
		signal?.throwIfAborted();
		const delayMs = Math.min(1e3 * 2 ** attempt, 1e4);
		emitPromptRetryNotice({
			error,
			delayMs,
			attempt: attempt + 1,
			maxRetries,
			suppressSdkConsoleErrors
		});
		await setTimeout$1(delayMs, void 0, { signal }).catch((error) => {
			signal?.throwIfAborted();
			throw error;
		});
		signal?.throwIfAborted();
		return !hasSideEffects();
	}
	return false;
}
function isTurnCancellation(error, signal) {
	return signal?.aborted === true && error === signal.reason;
}
function buildQueuedTaskRunOptions(sessionRecordId, task, options, outputFormatter) {
	return {
		sessionRecordId,
		requestId: task.requestId,
		mcpServers: options.mcpServers,
		prompt: task.prompt ?? textPrompt(task.message),
		permissionMode: task.permissionMode,
		resumePolicy: task.resumePolicy,
		nonInteractivePermissions: task.nonInteractivePermissions ?? options.nonInteractivePermissions,
		permissionPolicy: task.permissionPolicy,
		authCredentials: options.authCredentials,
		authPolicy: options.authPolicy,
		outputFormatter,
		errorEmissionPolicy: { queueErrorAlreadyEmitted: true },
		timeoutMs: task.timeoutMs,
		suppressSdkConsoleErrors: task.suppressSdkConsoleErrors ?? options.suppressSdkConsoleErrors,
		verbose: options.verbose,
		promptRetries: task.promptRetries ?? options.promptRetries ?? 0,
		sessionOptions: task.sessionOptions,
		onClientAvailable: options.onClientAvailable,
		onClientClosed: options.onClientClosed,
		onClientCloseFailure: options.onClientCloseFailure,
		onPromptActive: options.onPromptActive,
		onPromptFinalizing: options.onPromptFinalizing,
		onPromptRequestWritten: () => {
			if (task.reportPromptStarted) task.send({
				type: "prompt_started",
				requestId: task.requestId
			});
		},
		handleProcessInterrupts: options.handleProcessInterrupts,
		waitSignal: options.waitSignal,
		client: options.sharedClient
	};
}
function sendQueuedTaskResult(task, result) {
	if (!task.waitForCompletion) return;
	task.send({
		type: "result",
		requestId: task.requestId,
		result
	});
}
function sendQueuedTaskError(task, error) {
	if (!task.waitForCompletion) return;
	const normalizedError = normalizeOutputError(error, {
		origin: "runtime",
		detailCode: "QUEUE_RUNTIME_PROMPT_FAILED"
	});
	const alreadyEmitted = error.outputAlreadyEmitted === true;
	task.send({
		type: "error",
		requestId: task.requestId,
		code: normalizedError.code,
		detailCode: normalizedError.detailCode,
		origin: normalizedError.origin,
		message: normalizedError.message,
		retryable: normalizedError.retryable,
		acp: normalizedError.acp,
		outputAlreadyEmitted: alreadyEmitted
	});
}
async function runQueuedTask(sessionRecordId, task, options) {
	const outputFormatter = task.waitForCompletion ? new QueueTaskOutputFormatter(task) : DISCARD_OUTPUT_FORMATTER;
	try {
		sendQueuedTaskResult(task, await runSessionPrompt(buildQueuedTaskRunOptions(sessionRecordId, task, options, outputFormatter)));
	} catch (error) {
		sendQueuedTaskError(task, error);
		if (error instanceof InterruptedError) throw error;
	} finally {
		task.close();
	}
}
async function waitForSessionTurn(options) {
	const waiting = new AbortController();
	const onInterrupt = () => waiting.abort(new InterruptedError());
	const signals = [
		"SIGINT",
		"SIGTERM",
		"SIGHUP"
	];
	if (options.handleProcessInterrupts !== false) for (const signal of signals) process.once(signal, onInterrupt);
	const timeoutMs = options.timeoutMs;
	const timeout = timeoutMs != null && timeoutMs > 0 ? setTimeout(() => waiting.abort(new TimeoutError(timeoutMs)), timeoutMs) : void 0;
	const signal = options.waitSignal ? AbortSignal.any([waiting.signal, options.waitSignal]) : waiting.signal;
	try {
		const { acpxRecordId } = await resolveSessionRecord(options.sessionRecordId);
		return {
			recordId: acpxRecordId,
			ownership: await acquireSessionTurn(acpxRecordId, signal)
		};
	} catch (error) {
		return throwTurnAcquisitionError(error, signal);
	} finally {
		clearTimeout(timeout);
		for (const signal of signals) process.off(signal, onInterrupt);
	}
}
function throwTurnAcquisitionError(error, signal) {
	if (signal.aborted && error instanceof Error && error.name === "AbortError" && error.cause === signal.reason) throw signal.reason;
	throw error;
}
async function runSessionPrompt(options) {
	let turn;
	try {
		turn = await waitForSessionTurn(options);
	} catch (error) {
		if (options.ownedSignal) throw error;
		if (options.waitSignal?.aborted && error === options.waitSignal.reason) {
			const record = await resolveSessionRecord(options.sessionRecordId);
			return {
				sessionId: record.acpxRecordId,
				stopReason: "cancelled",
				permissionStats: {
					requested: 0,
					approved: 0,
					denied: 0,
					cancelled: 0
				},
				record,
				resumed: false
			};
		}
		throw error;
	}
	try {
		return await runOwnedSessionPrompt({
			...options,
			sessionRecordId: turn.recordId
		});
	} finally {
		await turn.ownership[Symbol.asyncDispose]();
	}
}
function preparePromptConversation(record, options) {
	const conversation = cloneSessionConversation(record);
	record.acpx = cloneSessionAcpxState(record.acpx);
	const promptStartedAt = isoNow$1();
	const promptMessageId = recordPromptSubmission(conversation, options.prompt, promptStartedAt);
	record.lastPromptAt = promptStartedAt;
	record.lastUsedAt = promptStartedAt;
	if (options.requestId !== void 0) record.lastRequestId = options.requestId;
	applyConversation(record, conversation);
	return {
		conversation,
		promptMessageId
	};
}
function failedWatchResult(error) {
	const { message, code, detailCode, retryable } = normalizeOutputError(error, {
		origin: "runtime",
		detailCode: "QUEUE_RUNTIME_PROMPT_FAILED"
	});
	return {
		status: "failed",
		error: {
			message,
			code,
			detailCode,
			retryable
		}
	};
}
async function writeTurnMarker(write) {
	try {
		await write();
	} catch (error) {
		throw new AcpxOperationalError(`Session journal write failed: ${formatErrorMessage(error)}`, {
			outputCode: "RUNTIME",
			detailCode: "SESSION_JOURNAL_WRITE_FAILED",
			origin: "runtime",
			retryable: false,
			cause: error
		});
	}
}
async function settleOperation(run) {
	try {
		return {
			status: "fulfilled",
			value: await run()
		};
	} catch (error) {
		return {
			status: "rejected",
			error
		};
	}
}
function settledWatchResult(outcome) {
	if (outcome.status === "rejected") return failedWatchResult(outcome.error);
	const result = outcome.value;
	return {
		status: result.stopReason === "cancelled" ? "cancelled" : "completed",
		stopReason: result.stopReason,
		...result._meta !== void 0 ? { _meta: result._meta } : {}
	};
}
async function runFinalizedSessionPrompt(options) {
	let journalStarted = false;
	const attempt = await settleOperation(async () => {
		const requestId = options.requestId;
		if (requestId !== void 0) {
			await writeTurnMarker(() => options.writer.beginTurn(requestId));
			journalStarted = true;
		}
		return await options.run();
	});
	const cleanup = await settleOperation(() => options.cleanup(attempt));
	const outcome = cleanup.status === "rejected" ? cleanup : attempt;
	const journal = await settleOperation(async () => {
		const requestId = options.requestId;
		if (journalStarted && requestId !== void 0) await writeTurnMarker(() => options.writer.finishTurn(requestId, settledWatchResult(outcome)));
	});
	const closing = await settleOperation(() => writeTurnMarker(() => options.writer.close({ checkpoint: false })));
	if (journal.status === "rejected") throw journal.error;
	if (outcome.status === "rejected") throw outcome.error;
	if (closing.status === "rejected") throw closing.error;
	return outcome.value;
}
async function runOwnedSessionPrompt(options) {
	const stopTotalTimer = startPerfTimer("runtime.prompt.total");
	const output = options.outputFormatter;
	const shouldMarkAcpErrorsEmitted = rendersAcpErrors(options.errorEmissionPolicy);
	const record = await measurePerf("session.resolve_prompt_record", async () => {
		return await resolveSessionRecord(options.sessionRecordId);
	});
	options.ownedSignal?.throwIfAborted();
	const { conversation, promptMessageId } = preparePromptConversation(record, options);
	await writeSessionRecord(record);
	options.ownedSignal?.throwIfAborted();
	output.setContext({ sessionId: record.acpxRecordId });
	const eventWriter = await measurePerf("session.events.open", async () => {
		return await SessionEventWriter.open(record);
	});
	const pendingMessages = [];
	const pendingConnectOutputMessages = [];
	const sessionOptions = mergeSessionOptions(options.sessionOptions, sessionOptionsFromRecord(record));
	let bufferingConnectOutput = true;
	let promptTurnActive = false;
	let promptTurnHadSideEffects = false;
	const acpErrors = new AcpErrorTracker();
	const flushPendingMessages = async (checkpoint = false) => {
		if (pendingMessages.length === 0) return;
		const batch = pendingMessages.splice(0);
		await measurePerf("session.events.flush_pending", async () => {
			await eventWriter.appendMessages(batch, { checkpoint });
		});
		if (options.requestId !== void 0) record.lastRequestId = options.requestId;
	};
	const preserveClosedState = async () => {
		const latest = await resolveSessionRecord(record.acpxRecordId).catch(() => void 0);
		if (!latest?.closed) return;
		record.closed = true;
		record.closedAt = latest.closedAt ?? record.closedAt ?? isoNow$1();
		record.pid = latest.pid;
		if (latest.acpx) record.acpx = {
			...record.acpx,
			...latest.acpx
		};
	};
	const liveCheckpoint = new LiveSessionCheckpoint({
		save: async () => {
			await flushPendingMessages(false);
			record.lastUsedAt = isoNow$1();
			applyConversation(record, conversation);
			await preserveClosedState();
			await eventWriter.checkpoint();
		},
		onError: (error) => {
			if (options.verbose) process.stderr.write("[acpx] live session checkpoint failed: " + formatErrorMessage(error) + "\n");
		}
	});
	let closeClientOnExit = options.client == null || options.ownedSignal !== void 0;
	const client = options.client ?? new AcpClient({
		agentCommand: record.agentCommand,
		agentArgv: record.agentArgv,
		cwd: absolutePath(record.cwd),
		mcpServers: options.mcpServers,
		permissionMode: options.permissionMode,
		nonInteractivePermissions: options.nonInteractivePermissions,
		permissionPolicy: options.permissionPolicy,
		authCredentials: options.authCredentials,
		authPolicy: options.authPolicy,
		fs: options.fs,
		terminal: options.terminal,
		suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
		verbose: options.verbose,
		sessionOptions
	});
	const permissionStatsBefore = client.getPermissionStats();
	client.updateRuntimeOptions({
		permissionMode: options.permissionMode,
		nonInteractivePermissions: options.nonInteractivePermissions,
		permissionPolicy: options.permissionPolicy,
		fs: options.fs,
		terminal: options.terminal,
		suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
		verbose: options.verbose
	});
	const closeOwnedClient = options.closeProvidedClient ?? ownDirectClient(client, options.ownedSignal);
	client.setEventHandlers({
		onAcpMessage: (direction, message) => {
			pendingMessages.push(message);
			options.onAcpMessage?.(direction, message);
		},
		onAcpOutputMessage: (direction, message) => {
			if (bufferingConnectOutput) {
				pendingConnectOutputMessages.push({
					direction,
					message
				});
				return;
			}
			acpErrors.observe(output, direction, message);
		},
		onSessionUpdate: (notification) => {
			if (promptTurnActive) promptTurnHadSideEffects = true;
			record.acpx = recordSessionUpdate(conversation, record.acpx, notification);
			trimConversationForRuntime(conversation);
			liveCheckpoint.request();
			options.onSessionUpdate?.(notification);
		},
		onClientOperation: (operation) => {
			if (promptTurnActive) promptTurnHadSideEffects = true;
			record.acpx = recordClientOperation(conversation, record.acpx, operation);
			trimConversationForRuntime(conversation);
			liveCheckpoint.request();
			options.onClientOperation?.(operation);
		},
		onPermissionEscalation: (event) => {
			output.onPermissionEscalation(event);
			options.onPermissionEscalation?.(event);
		}
	});
	let activeSessionIdForControl = record.acpSessionId;
	let notifiedClientAvailable = false;
	let controlRetirement;
	const activeController = {
		hasActivePrompt: () => client.hasActivePrompt(),
		requestCancelActivePrompt: async () => await client.requestCancelActivePrompt(),
		...createOwnedSessionControls({
			client,
			record,
			sessionId: () => activeSessionIdForControl,
			checkpoint: () => liveCheckpoint.checkpoint(),
			retire: () => {
				controlRetirement ??= client.close().catch((error) => {
					options.onClientCloseFailure?.();
					throw error;
				});
				return controlRetirement;
			}
		})
	};
	const flushConnectOutput = (loadError) => {
		bufferingConnectOutput = false;
		const outputMessages = filterBufferedConnectOutput(pendingConnectOutputMessages, loadError);
		for (const { direction, message } of outputMessages) acpErrors.observe(output, direction, message);
		pendingConnectOutputMessages.length = 0;
	};
	const connectForPrompt = async () => {
		const connectStartedAt = Date.now();
		try {
			const connected = await measurePerf("runtime.connect_and_load", async () => {
				return await connectAndLoadSession({
					client,
					record,
					resumePolicy: options.resumePolicy,
					sessionOptions: options.sessionOptions,
					replacingConfigOption: requestedModelId(options.sessionOptions?.model) ? { key: "model" } : void 0,
					timeoutMs: options.timeoutMs,
					verbose: options.verbose,
					suppressWarnings: options.suppressSdkConsoleErrors,
					promptRecorded: true,
					activeController,
					authority: { signal: options.ownedSignal },
					onClientAvailable: (controller) => {
						options.onClientAvailable?.(controller);
						notifiedClientAvailable = true;
					},
					onConnectedRecord: (connectedRecord) => {
						connectedRecord.lastPromptAt = isoNow$1();
					},
					onSessionIdResolved: (sessionId) => {
						activeSessionIdForControl = sessionId;
					}
				});
			});
			flushConnectOutput(connected.loadError);
			emitConnectPerfMetric(connectStartedAt, options.verbose);
			return connected;
		} catch (error) {
			closeClientOnExit = true;
			flushConnectOutput();
			throw error;
		}
	};
	const buildPromptStartedHook = (attempt) => {
		if (attempt !== 0 || !options.onPromptActive) return;
		return async () => {
			try {
				await options.onPromptActive?.();
			} catch (error) {
				emitPromptHookError(error, options.verbose);
			}
		};
	};
	const runPromptAttempt = async (sessionId, attempt) => {
		acpErrors.reset();
		const promptStartedAt = Date.now();
		const response = await measurePerf("runtime.prompt.agent_turn", async () => {
			return await runPromptTurn({
				client,
				sessionId,
				prompt: options.prompt,
				timeoutMs: options.timeoutMs,
				conversation,
				promptMessageId,
				onPromptRequestWritten: options.onPromptRequestWritten,
				onPromptStarted: buildPromptStartedHook(attempt),
				authority: { signal: options.waitSignal }
			});
		});
		emitPromptPerfMetric(promptStartedAt, options.verbose);
		return response;
	};
	const handlePromptFailure = async (error, attempt) => {
		if (isTurnCancellation(error, options.waitSignal)) throw error;
		const snapshot = client.getAgentLifecycleSnapshot();
		if (snapshot.lastExit?.unexpectedDuringPrompt !== true && await preparePromptRetry(error, attempt, options.promptRetries ?? 0, () => promptTurnHadSideEffects, options.suppressSdkConsoleErrors, options.waitSignal)) return;
		await failRuntimePrompt(error, snapshot);
	};
	const failRuntimePrompt = async (error, snapshot) => {
		promptTurnActive = false;
		applyLifecycleSnapshotToRecord(record, snapshot);
		emitPromptDisconnectNotice(snapshot, options.verbose);
		const matchedAcpError = acpErrors.match(error);
		const normalizedError = normalizeOutputError(error, {
			origin: "runtime",
			acp: matchedAcpError
		});
		await flushPendingMessages(false).catch(() => {});
		output.flush();
		record.lastUsedAt = isoNow$1();
		applyConversation(record, conversation);
		const propagated = error instanceof Error ? error : new Error(formatErrorMessage(error));
		attachAcpErrorPayload(propagated, normalizedError.acp);
		markOutputAlreadyEmitted(propagated, matchedAcpError !== void 0 && shouldMarkAcpErrorsEmitted);
		propagated.normalizedOutputError = normalizedError;
		throw propagated;
	};
	const runPromptWithRetries = async (sessionId) => {
		promptTurnActive = true;
		try {
			for (let attempt = 0;; attempt++) {
				options.waitSignal?.throwIfAborted();
				try {
					return await runPromptAttempt(sessionId, attempt);
				} catch (error) {
					await handlePromptFailure(error, attempt);
				}
			}
		} catch (error) {
			if (isTurnCancellation(error, options.waitSignal)) return { stopReason: "cancelled" };
			throw error;
		}
	};
	const savePromptSuccess = async (response) => {
		await flushPendingMessages(false);
		output.flush();
		const now = isoNow$1();
		record.lastUsedAt = now;
		record.closed = false;
		record.closedAt = void 0;
		if (client.initializeResult) {
			record.protocolVersion = client.initializeResult.protocolVersion;
			record.agentCapabilities = client.initializeResult.agentCapabilities;
		}
		applyConversation(record, conversation);
		applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
		stopTotalTimer();
		return response;
	};
	const runPrompt = async () => {
		options.ownedSignal?.throwIfAborted();
		const { sessionId: activeSessionId, resumed, loadError } = await connectForPrompt();
		options.ownedSignal?.throwIfAborted();
		try {
			await applyPromptModelIfAdvertised({
				client,
				sessionId: activeSessionId,
				requestedModel: options.sessionOptions?.model,
				record,
				timeoutMs: options.timeoutMs,
				suppressWarnings: options.suppressSdkConsoleErrors,
				signal: options.ownedSignal
			});
		} catch (error) {
			if (error instanceof TimeoutError) closeClientOnExit = true;
			throw error;
		}
		options.ownedSignal?.throwIfAborted();
		output.setContext({ sessionId: record.acpxRecordId });
		await liveCheckpoint.checkpoint();
		const response = await savePromptSuccess(await runPromptWithRetries(activeSessionId));
		promptTurnActive = false;
		return {
			...toPromptResult(response.stopReason, record.acpxRecordId, client, permissionStatsBefore, response._meta),
			record,
			resumed,
			loadError
		};
	};
	const handleInterrupt = async () => {
		await client.cancelActivePrompt(INTERRUPT_CANCEL_WAIT_MS);
		applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
		record.lastUsedAt = isoNow$1();
		applyConversation(record, conversation);
		await flushPendingMessages(false).catch(() => {});
		if (closeClientOnExit) await closeOwnedClient();
	};
	const runObservedPrompt = async () => {
		try {
			const result = await runWithOptionalInterrupt({
				handleProcessInterrupts: options.handleProcessInterrupts,
				run: runPrompt,
				handleInterrupt
			});
			options.ownedSignal?.throwIfAborted();
			return result;
		} catch (error) {
			const failure = directExecutionError(error, options.ownedSignal);
			const matchedAcpError = acpErrors.match(failure);
			attachAcpErrorPayload(failure, matchedAcpError);
			markOutputAlreadyEmitted(failure, matchedAcpError !== void 0 && shouldMarkAcpErrorsEmitted);
			throw failure;
		}
	};
	const cleanupPrompt = async (attempt) => {
		const controlDrain = options.onPromptFinalizing?.();
		const unresolvedPrompt = client.hasUnresolvedPrompt();
		const steps = [
			async () => {
				if (unresolvedPrompt) await withTimeout(client.cancelActivePrompt(INTERRUPT_CANCEL_WAIT_MS), INTERRUPT_CANCEL_WAIT_MS).catch(() => {});
			},
			async () => {
				const journalFailed = attempt.status === "rejected" && attempt.error instanceof AcpxOperationalError && attempt.error.detailCode === "SESSION_JOURNAL_WRITE_FAILED";
				if (unresolvedPrompt || closeClientOnExit || journalFailed) try {
					await closeOwnedClient();
				} catch (error) {
					options.onClientCloseFailure?.();
					throw error;
				}
			},
			async () => {
				await controlDrain;
			},
			() => {
				const duration = stopTotalTimer();
				if (options.verbose) process.stderr.write(`[acpx] ${formatPerfMetric("prompt.total", duration)}\n`);
			},
			() => {
				if (notifiedClientAvailable) options.onClientClosed?.();
			},
			() => client.clearEventHandlers(),
			() => applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot()),
			() => applyConversation(record, conversation)
		];
		const outcomes = [];
		for (const step of steps) outcomes.push(await settleOperation(step));
		for (const checkpoint of [
			() => liveCheckpoint.flush(),
			() => flushPendingMessages(false),
			preserveClosedState,
			() => eventWriter.checkpoint()
		]) await settleOperation(checkpoint);
		const failure = outcomes.find((outcome) => outcome.status === "rejected");
		if (failure) throw failure.error;
	};
	return await runFinalizedSessionPrompt({
		writer: eventWriter,
		requestId: options.requestId,
		run: runObservedPrompt,
		cleanup: cleanupPrompt
	});
}
async function runOnce(options, control) {
	const authority = { signal: control?.signal };
	const output = options.outputFormatter;
	const shouldMarkAcpErrorsEmitted = rendersAcpErrors(options.errorEmissionPolicy);
	let promptTurnActive = false;
	let promptTurnHadSideEffects = false;
	let controlState = {};
	let sawOwnedModelConfig = false;
	const acpErrors = new AcpErrorTracker();
	const client = new AcpClient({
		agentCommand: options.agentCommand,
		agentArgv: options.agentArgv,
		cwd: absolutePath(options.cwd),
		mcpServers: options.mcpServers,
		permissionMode: options.permissionMode,
		nonInteractivePermissions: options.nonInteractivePermissions,
		permissionPolicy: options.permissionPolicy,
		authCredentials: options.authCredentials,
		authPolicy: options.authPolicy,
		fs: options.fs,
		terminal: options.terminal,
		suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
		verbose: options.verbose,
		onAcpMessage: options.onAcpMessage,
		onAcpOutputMessage: (direction, message) => {
			acpErrors.observe(output, direction, message);
		},
		onSessionUpdate: (notification) => {
			if (notification.update.sessionUpdate === "config_option_update" && client.hasReusableSession(notification.sessionId)) {
				controlState = applyConfigOptionsToState(controlState, notification.update.configOptions);
				sawOwnedModelConfig ||= controlState.model_control === "config_option";
			}
			if (promptTurnActive) promptTurnHadSideEffects = true;
			options.onSessionUpdate?.(notification);
		},
		onClientOperation: (operation) => {
			if (promptTurnActive) promptTurnHadSideEffects = true;
			options.onClientOperation?.(operation);
		},
		onPermissionEscalation: (event) => {
			output.onPermissionEscalation(event);
			options.onPermissionEscalation?.(event);
		},
		sessionOptions: options.sessionOptions
	});
	const permissionStatsBefore = client.getPermissionStats();
	const closeOwnedClient = ownDirectClient(client, control?.signal);
	const initializeControlState = (createdSession) => {
		const configOptions = controlState.config_options ?? createdSession.configOptions ?? [];
		if (createdSession.models && !sawOwnedModelConfig) applyAdvertisedModelState(controlState, createdSession.models);
		controlState = applyConfigOptionsToState(controlState, configOptions);
	};
	const runExecPromptAttempt = async (sessionId) => {
		assertControlAuthority(authority);
		acpErrors.reset();
		return await measurePerf("runtime.exec.prompt", async () => {
			return await withTimeout(client.prompt(sessionId, options.prompt, void 0, void 0, void 0, { signal: control?.signal }), options.timeoutMs);
		});
	};
	const runExecPromptWithRetries = async (sessionId) => {
		const maxRetries = options.promptRetries ?? 0;
		promptTurnActive = true;
		for (let attempt = 0;; attempt++) try {
			return await runExecPromptAttempt(sessionId);
		} catch (error) {
			if (await preparePromptRetry(error, attempt, maxRetries, () => promptTurnHadSideEffects, options.suppressSdkConsoleErrors, control?.signal)) continue;
			promptTurnActive = false;
			throw error;
		}
	};
	try {
		return await runWithOptionalInterrupt({
			handleProcessInterrupts: control?.handleProcessInterrupts,
			run: async () => {
				assertControlAuthority(authority);
				await measurePerf("runtime.exec.start", async () => {
					await withTimeout(client.start(authority), options.timeoutMs);
				});
				assertControlAuthority(authority);
				const createdSession = await measurePerf("runtime.exec.create_session", async () => {
					return await withTimeout(client.createSession(absolutePath(options.cwd), authority), options.timeoutMs);
				});
				assertControlAuthority(authority);
				const sessionId = createdSession.sessionId;
				initializeControlState(createdSession);
				const modelApplication = await applyRequestedModelIfAdvertised({
					client,
					sessionId,
					requestedModel: options.sessionOptions?.model,
					models: advertisedModelState(controlState),
					agentCommand: options.agentCommand,
					timeoutMs: options.timeoutMs,
					authority,
					onWarning: options.suppressSdkConsoleErrors ? void 0 : (message) => process.stderr.write(`[acpx] warning: ${message}\n`)
				});
				if (modelApplication.applied) controlState = applyModelSelection(controlState, modelApplication.modelId, modelApplication.response, modelApplication.resolvedModelId);
				for (const configOption of options.configOptions ?? []) {
					assertControlAuthority(authority);
					const models = advertisedModelState(controlState);
					const { modelConfigId, resolvedValue } = resolveRequestedConfigOption({
						...configOption,
						models,
						agentCommand: options.agentCommand
					});
					const response = await withTimeout(client.setSessionConfigOption(sessionId, configOption.configId, configOption.value, models, authority), options.timeoutMs);
					controlState = applyConfigOptionSelection(controlState, configOption.configId, configOption.value, response, modelConfigId, resolvedValue);
				}
				assertControlAuthority(authority);
				output.setContext({ sessionId });
				const response = await runExecPromptWithRetries(sessionId);
				promptTurnActive = false;
				return toPromptResult(response.stopReason, sessionId, client, permissionStatsBefore, response._meta);
			},
			handleInterrupt: async () => {
				await client.cancelActivePrompt(INTERRUPT_CANCEL_WAIT_MS);
				await closeOwnedClient();
			}
		});
	} catch (error) {
		const failure = directExecutionError(error, authority.signal);
		const matchedAcpError = acpErrors.match(failure);
		attachAcpErrorPayload(failure, matchedAcpError);
		markOutputAlreadyEmitted(failure, matchedAcpError !== void 0 && shouldMarkAcpErrorsEmitted);
		throw failure;
	} finally {
		try {
			await closeOwnedClient();
		} finally {
			try {
				options.onPermissionStats?.(client.getPermissionStats());
			} catch {}
			output.flush();
		}
	}
}
async function sendSessionDirect(options, control) {
	const closeProvidedClient = control && options.client ? ownDirectClient(options.client, control.signal) : void 0;
	try {
		control?.signal.throwIfAborted();
		return await runSessionPrompt({
			ownedSignal: control?.signal,
			closeProvidedClient,
			waitSignal: control?.signal,
			handleProcessInterrupts: control?.handleProcessInterrupts,
			sessionRecordId: options.sessionId,
			prompt: options.prompt,
			mcpServers: options.mcpServers,
			permissionMode: options.permissionMode,
			resumePolicy: options.resumePolicy,
			nonInteractivePermissions: options.nonInteractivePermissions,
			permissionPolicy: options.permissionPolicy,
			authCredentials: options.authCredentials,
			authPolicy: options.authPolicy,
			fs: options.fs,
			terminal: options.terminal,
			outputFormatter: options.outputFormatter,
			errorEmissionPolicy: options.errorEmissionPolicy,
			onAcpMessage: options.onAcpMessage,
			onSessionUpdate: options.onSessionUpdate,
			onClientOperation: options.onClientOperation,
			onPermissionEscalation: options.onPermissionEscalation,
			timeoutMs: options.timeoutMs,
			suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
			verbose: options.verbose,
			client: options.client
		});
	} finally {
		await closeProvidedClient?.();
	}
}
// src/session/execution/queue-owner-runtime.ts
const QUEUE_OWNER_STARTUP_MAX_ATTEMPTS = 120;
const QUEUE_OWNER_HEARTBEAT_INTERVAL_MS = 5e3;
const QUEUE_OWNER_ACTIVE_TURN_CANCEL_GRACE_MS = 750;
async function submitToRunningOwner(options, waitForCompletion, extras) {
	return await trySubmitToRunningOwner({
		sessionId: options.sessionId,
		requestId: options.requestId,
		requireSharedRuntime: options.requireSharedRuntime,
		signal: options.signal,
		message: promptToDisplayText(options.prompt),
		prompt: options.prompt,
		mcpConfigPath: options.mcpConfigPath,
		mcpConfigFingerprint: options.mcpConfigFingerprint,
		permissionMode: options.permissionMode,
		resumePolicy: options.resumePolicy,
		nonInteractivePermissions: options.nonInteractivePermissions,
		permissionPolicy: options.permissionPolicy,
		outputFormatter: options.outputFormatter,
		errorEmissionPolicy: options.errorEmissionPolicy,
		timeoutMs: options.timeoutMs,
		suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
		promptRetries: options.promptRetries,
		waitForCompletion,
		verbose: options.verbose,
		sessionOptions: options.sessionOptions,
		onQueueAccepted: () => {
			extras?.onQueueAccepted?.();
			options.onQueueAccepted?.();
		},
		onPromptStarted: options.onPromptStarted
	});
}
function createQueueOwnerSharedClient(options, sessionRecord) {
	return new AcpClient({
		agentCommand: sessionRecord.agentCommand,
		agentArgv: sessionRecord.agentArgv,
		cwd: absolutePath(sessionRecord.cwd),
		mcpServers: options.mcpServers,
		permissionMode: options.permissionMode,
		nonInteractivePermissions: options.nonInteractivePermissions,
		authCredentials: options.authCredentials,
		authPolicy: options.authPolicy,
		fs: options.fs,
		terminal: options.terminal,
		suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
		verbose: options.verbose,
		sessionOptions: mergeSessionOptions(options.sessionOptions, sessionOptionsFromRecord(sessionRecord))
	});
}
function logDeferredCancelFailure(error, verbose) {
	if (!verbose) return;
	process.stderr.write(`[acpx] failed to apply deferred cancel: ${formatErrorMessage(error)}\n`);
}
function queueOwnerExitIsFatal(exit) {
	return exit.exited && (exit.spawnError !== void 0 || exit.inputError !== void 0 || exit.code !== 0 || exit.signal !== null);
}
function logQueueOwnerReady(params) {
	if (!params.verbose) return;
	process.stderr.write(`[acpx] queue owner ready for session ${params.sessionId} (ttlMs=${params.ttlMs}, maxQueueDepth=${params.maxQueueDepth})\n`);
}
async function closeQueueOwnerRuntime(params) {
	params.turnController.beginClosing();
	await params.sharedClient.close().catch(() => {});
	await params.owner?.close();
	await writeQueueOwnerLifecycleSnapshot(params.sessionId, params.sharedClient);
	if (params.verbose) process.stderr.write(`[acpx] queue owner stopped for session ${params.sessionId}\n`);
}
async function writeQueueOwnerLifecycleSnapshot(sessionId, sharedClient) {
	try {
		const record = await resolveSessionRecord(sessionId);
		applyLifecycleSnapshotToRecord(record, sharedClient.getAgentLifecycleSnapshot());
		await writeSessionRecord(record);
	} catch {}
}
async function settlesWithin(promise, timeoutMs) {
	let timer;
	const timeout = new Promise((resolve) => {
		timer = setTimeout(() => resolve(false), timeoutMs);
	});
	try {
		return await Promise.race([promise.then(() => true, () => true), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
function createQueueOwnerShutdownController(params) {
	let requested = false;
	let activeTurn;
	let activeTurnShutdown;
	let shutdownPromise;
	const drainActiveTurn = async () => {
		const turn = activeTurn;
		const pending = Promise.allSettled([turn, params.controls.drainAdmitted()]);
		if (turn) params.turnController.requestCancel().catch((error) => {
			logDeferredCancelFailure(error, params.verbose);
		});
		if (!await settlesWithin(pending, QUEUE_OWNER_ACTIVE_TURN_CANCEL_GRACE_MS)) await params.sharedClient.close().catch(() => {});
		await pending;
	};
	const request = () => {
		requested = true;
		params.stopHeartbeat();
		params.controls.stopAdmission();
		params.getOwner()?.beginShutdown();
		activeTurnShutdown ??= drainActiveTurn();
	};
	return {
		get requested() {
			return requested;
		},
		request,
		setActiveTurn: (turn) => {
			activeTurn = turn;
			if (requested) activeTurnShutdown = Promise.all([activeTurnShutdown, drainActiveTurn()]).then(() => {});
		},
		clearActiveTurn: (turn) => {
			if (activeTurn === turn) activeTurn = void 0;
		},
		drain: () => {
			request();
			return activeTurnShutdown;
		},
		shutdown: () => {
			request();
			shutdownPromise ??= (async () => {
				await activeTurnShutdown;
				await params.getBackendClose()?.catch(() => {});
				await closeQueueOwnerRuntime({
					owner: params.getOwner(),
					turnController: params.turnController,
					sharedClient: params.sharedClient,
					sessionId: params.sessionId,
					verbose: params.verbose
				});
			})();
			return shutdownPromise;
		}
	};
}
function applyRequestedShutdown(owner, shutdown) {
	if (shutdown.requested) owner.beginShutdown();
}
function startQueueOwnerHeartbeat(params) {
	if (!params.enabled) return;
	return setInterval(() => {
		params.refresh(params.owner.queueDepth());
	}, QUEUE_OWNER_HEARTBEAT_INTERVAL_MS);
}
function createLeaseHeartbeat(lease, shutdown) {
	let guardFailure;
	return {
		refresh: async (queueDepth) => {
			if (shutdown.requested) return;
			await refreshQueueOwnerLease(lease, { queueDepth }).catch((error) => {
				if (error instanceof QueueLeaseGuardSettlementError) {
					guardFailure ??= error;
					shutdown.request();
				}
			});
		},
		throwIfFailed: () => {
			if (guardFailure) throw guardFailure;
		}
	};
}
async function runSessionQueueOwner(options) {
	const signals = [
		"SIGINT",
		"SIGTERM",
		"SIGHUP"
	];
	let stopRequested = false;
	let requestRuntimeStop;
	const onSignal = () => {
		stopRequested = true;
		requestRuntimeStop?.();
	};
	try {
		for (const signal of signals) process.on(signal, onSignal);
		const lease = await tryAcquireQueueOwnerLease(options.sessionId, {
			path: options.mcpConfigPath,
			fingerprint: options.mcpConfigFingerprint
		});
		if (!lease) return;
		let runtimeFailure;
		try {
			await runQueueOwnerRuntime(options, lease, (requestStop) => {
				requestRuntimeStop = requestStop;
				if (stopRequested) requestStop();
			});
		} catch (error) {
			runtimeFailure = { error };
		}
		try {
			await releaseQueueOwnerLease(lease);
		} catch (error) {
			if (runtimeFailure) throw new AggregateError([runtimeFailure.error, error], "Queue owner shutdown failed", { cause: error });
			throw error;
		}
		if (runtimeFailure) throw runtimeFailure.error;
	} finally {
		for (const signal of signals) process.off(signal, onSignal);
	}
}
async function keepOwnerForPendingControls(controls, shutdown) {
	if (shutdown.requested || !controls.hasPending) return false;
	await controls.drainAdmitted();
	return !shutdown.requested;
}
async function runQueueOwnerRuntime(options, lease, bindStopRequest) {
	const sessionRecord = await resolveSessionRecord(options.sessionId);
	let owner;
	let heartbeatTimer;
	const sharedClient = createQueueOwnerSharedClient(options, sessionRecord);
	const ttlMs = normalizeQueueOwnerTtlMs(options.ttlMs);
	const maxQueueDepth = Math.max(1, Math.round(options.maxQueueDepth ?? 16));
	const taskPollTimeoutMs = ttlMs === 0 ? void 0 : ttlMs;
	const initialTaskPollTimeoutMs = taskPollTimeoutMs == null ? void 0 : Math.max(taskPollTimeoutMs, 1e3);
	const turnController = new QueueOwnerTurnController();
	let activeControls;
	let backendCloseRequest;
	const controls = new QueueOwnerControlAdmission({ runIdle: async (invoke, controlOptions) => await runIdleOwnerControl({
		...controlOptions,
		client: sharedClient,
		sessionId: options.sessionId,
		verbose: options.verbose,
		onRetirementFailure: () => shutdown.request()
	}, invoke) });
	const applyPendingCancel = async () => {
		return await turnController.applyPendingCancel();
	};
	const scheduleApplyPendingCancel = () => {
		applyPendingCancel().catch((error) => {
			logDeferredCancelFailure(error, options.verbose);
		});
	};
	const setActiveController = (controller) => {
		activeControls = controller;
		turnController.setActiveController(controller);
		scheduleApplyPendingCancel();
	};
	const clearActiveController = () => {
		activeControls = void 0;
		turnController.clearActiveController();
	};
	const closeActiveBackendSession = (timeoutMs) => {
		backendCloseRequest ??= Promise.resolve().then(async () => {
			await shutdown.drain();
			const latestRecord = await resolveSessionRecord(options.sessionId);
			if (!sharedClient.supportsCloseSession()) return false;
			await withTimeout(sharedClient.closeSession(latestRecord.acpSessionId), timeoutMs);
			return true;
		});
		return backendCloseRequest;
	};
	const runPromptTurn = async (run) => {
		const waitSignal = turnController.beginTurn();
		const { ticket, priorIdle } = controls.beginPrompt();
		if (shutdown.requested) turnController.requestCancel().catch(() => {});
		try {
			await priorIdle;
			return await run(waitSignal, ticket);
		} finally {
			await controls.seal(ticket);
			controls.release(ticket);
			turnController.endTurn();
		}
	};
	const shutdown = createQueueOwnerShutdownController({
		getOwner: () => owner,
		stopHeartbeat: () => {
			if (heartbeatTimer) {
				clearInterval(heartbeatTimer);
				heartbeatTimer = void 0;
			}
		},
		turnController,
		controls,
		getBackendClose: () => backendCloseRequest,
		sharedClient,
		sessionId: options.sessionId,
		verbose: options.verbose
	});
	bindStopRequest(shutdown.request);
	const heartbeat = createLeaseHeartbeat(lease, shutdown);
	try {
		owner = await SessionQueueOwner.start(lease, {
			cancelPrompt: async () => {
				if (!await turnController.requestCancel()) return false;
				await applyPendingCancel();
				return true;
			},
			closeSession: async (timeoutMs) => await closeActiveBackendSession(timeoutMs),
			setSessionMode: async (modeId, timeoutMs) => {
				await controls.run((context, deadline) => context.setSessionMode(modeId, deadline), timeoutMs);
			},
			setSessionModel: async (modelId, timeoutMs) => await controls.run((context, deadline) => context.setSessionModel(modelId, deadline), timeoutMs, { key: "model" }),
			setSessionConfigOption: async (configId, value, timeoutMs) => {
				return await controls.run((context, deadline) => context.setSessionConfigOption(configId, value, deadline), timeoutMs, { key: configId });
			}
		}, {
			maxQueueDepth,
			onQueueDepthChanged: (queueDepth) => {
				setPerfGauge("queue.owner.depth", queueDepth);
				heartbeat.refresh(queueDepth);
			}
		});
		applyRequestedShutdown(owner, shutdown);
		logQueueOwnerReady({
			sessionId: options.sessionId,
			ttlMs,
			maxQueueDepth,
			verbose: options.verbose
		});
		await heartbeat.refresh(owner.queueDepth());
		heartbeatTimer = startQueueOwnerHeartbeat({
			enabled: !shutdown.requested,
			refresh: heartbeat.refresh,
			owner
		});
		let isFirstTask = true;
		while (true) {
			const pollTimeoutMs = isFirstTask ? initialTaskPollTimeoutMs : taskPollTimeoutMs;
			const task = await owner.nextTask(pollTimeoutMs);
			if (!task) {
				if (await keepOwnerForPendingControls(controls, shutdown)) continue;
				break;
			}
			isFirstTask = false;
			const turnPromise = runPromptTurn(async (waitSignal, ticket) => {
				try {
					await runQueuedTask(options.sessionId, task, {
						sharedClient,
						verbose: options.verbose,
						mcpServers: options.mcpServers,
						nonInteractivePermissions: options.nonInteractivePermissions,
						authCredentials: options.authCredentials,
						authPolicy: options.authPolicy,
						suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
						promptRetries: task.promptRetries ?? 0,
						sessionOptions: options.sessionOptions,
						onClientAvailable: setActiveController,
						onClientClosed: clearActiveController,
						onClientCloseFailure: shutdown.request,
						onPromptFinalizing: () => controls.seal(ticket),
						onPromptActive: async () => {
							if (activeControls) controls.publish(ticket, activeControls);
							turnController.markPromptActive();
							await applyPendingCancel();
						},
						handleProcessInterrupts: false,
						waitSignal
					});
				} finally {
					checkpointPerfMetricsCapture();
				}
			});
			shutdown.setActiveTurn(turnPromise);
			try {
				await turnPromise;
			} finally {
				shutdown.clearActiveTurn(turnPromise);
				owner.completeTask(task);
			}
		}
	} finally {
		await shutdown.shutdown();
		await lease.updates;
	}
	heartbeat.throwIfFailed();
}
async function sendSession(options) {
	options.signal?.throwIfAborted();
	const waitForCompletion = options.waitForCompletion !== false;
	const queuedToOwner = await submitToRunningOwner(options, waitForCompletion);
	if (queuedToOwner) return queuedToOwner;
	options.signal?.throwIfAborted();
	const owner = spawnQueueOwnerProcess(queueOwnerRuntimeOptionsFromSend(options), options.queueOwnerArgs);
	const onQueueAccepted = () => {
		owner.stopStartupCapture();
	};
	try {
		for (let attempt = 0; attempt < QUEUE_OWNER_STARTUP_MAX_ATTEMPTS; attempt += 1) {
			options.signal?.throwIfAborted();
			const queued = await submitToRunningOwner(options, waitForCompletion, { onQueueAccepted });
			if (queued) return queued;
			const exit = owner.getExitState();
			if (queueOwnerExitIsFatal(exit)) {
				const message = formatQueueOwnerStartupFailure({
					sessionId: options.sessionId,
					exit,
					logTail: owner.readLogTail()
				});
				throw new Error(message);
			}
			await waitMs$1(50);
		}
		const message = formatQueueOwnerStartupFailure({
			sessionId: options.sessionId,
			exit: owner.getExitState(),
			logTail: owner.readLogTail()
		});
		throw new Error(message);
	} finally {
		owner.stopStartupCapture();
	}
}
const queueOwnerRuntimeTestInternals = { queueOwnerExitIsFatal };
export { isRequestedModelUnsupportedError as $, applyInitialModelSelection as A, reconcileAgentSessionId as B, setSessionModeOnOwner as C, connectAndLoadSession as D, withConnectedSession as E, persistSessionOptions as F, recordSessionUpdate as G, createSessionConversation as H, sessionOptionsFromRecord as I, advertisedModelState as J, trimConversationForRuntime as K, applyConversation as L, applyRequestedModelIfAdvertised as M, setDesiredModeId as N, applyConfigOptionSelection as O, normalizeSessionOptionShape as P, RequestedModelUnsupportedError as Q, applyLifecycleSnapshotToRecord as R, setSessionMode as S, setSessionModelOnOwner as T, recordClientOperation as U, cloneSessionConversation as V, recordPromptSubmission as W, REQUESTED_MODEL_UNSUPPORTED_ERROR_CODE as X, AcpClient as Y, REQUESTED_MODEL_UNSUPPORTED_REASONS as Z, cancelSessionPrompt as _, runQueuedTask as a, DEFAULT_QUEUE_OWNER_TTL_MS as at, setSessionConfigOption as b, LiveSessionCheckpoint as c, acquireSessionScope as ct, flushPerfMetricsCapture as d, InterruptedError as dt, resolveRequestedConfigOption as et, installPerfMetricsCapture as f, TimeoutError as ft, listAgentSessions as g, ensureSession as h, withTimeout as ht, runOnce as i, permissionModeSatisfies as it, applyModelSelection as j, applyConfigOptionsToRecord as k, runPromptTurn as l, listSessionEvents as lt, createSessionWithClient as m, withInterrupt as mt, runSessionQueueOwner as n, getAcpxVersion as nt, sendSessionDirect as o, normalizeQueueOwnerTtlMs as ot, createSession as p, assertControlAuthority as pt, cloneSessionAcpxState as q, sendSession as r, snapshotEnvNames as rt, DISCARD_OUTPUT_FORMATTER as s, acquireSessionImport as st, queueOwnerRuntimeTestInternals as t, resolveRequestedModelId as tt, buildQueueOwnerArgOverride as u, isLegacyZedCodexAcpInvocation as ut, closeSession as v, setSessionModel as w, setSessionConfigOptionOnOwner as x, sessionControlTestInternals as y, createInitialSessionRecord as z };
