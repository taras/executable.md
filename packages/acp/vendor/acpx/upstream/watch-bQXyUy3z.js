import { E as observeProcessIncarnation, J as SessionWatchError, L as readSessionRecord, Y as watchSession$1, Zt as SessionNotFoundError, l as readQueueOwnerRecord } from "./ipc-BbYFsKOj.js";
// src/session/watch.ts
const OWNER_OBSERVATION_REUSE_MS = 1e3;
function reuseObservation(cached) {
	if (!cached) return false;
	if (cached.decisionPending) {
		cached.decisionPending = false;
		return true;
	}
	return cached.state === "gone" || performance.now() - cached.checkedAt < OWNER_OBSERVATION_REUSE_MS;
}
function selectOwner(owner, observation) {
	const key = owner ? JSON.stringify([
		owner.pid,
		owner.ownerGeneration,
		owner.processIdentity
	]) : null;
	if (key === observation.ownerKey) return false;
	observation.ownerKey = key;
	observation.incarnation = void 0;
	observation.missingRequest = null;
	return true;
}
async function runningOwner(recordId, observation) {
	let owner = await readQueueOwnerRecord(recordId);
	selectOwner(owner, observation);
	if (!owner) return { queried: false };
	const cached = observation.incarnation;
	let queried = false;
	if (!reuseObservation(cached)) {
		queried = true;
		const state = await observeProcessIncarnation(owner.pid, owner.processIdentity);
		owner = await readQueueOwnerRecord(recordId);
		if (selectOwner(owner, observation)) return {
			owner,
			queried
		};
		observation.incarnation = {
			state,
			checkedAt: performance.now(),
			decisionPending: true
		};
	}
	return {
		owner: observation.incarnation?.state === "gone" ? void 0 : owner,
		queried
	};
}
async function continueWatching(recordId, pendingRequestId, observation) {
	const { owner, queried } = await runningOwner(recordId, observation);
	if (queried) {
		observation.missingRequest = owner ? null : pendingRequestId;
		return true;
	}
	if (owner) {
		if (!owner.sessionWatch) throw new SessionWatchError("WATCH_OWNER_UNSUPPORTED", "This running session owner predates passive watching. Let it expire when idle or explicitly close the session before starting new work.");
		observation.missingRequest = null;
		return true;
	}
	if (pendingRequestId && pendingRequestId === observation.missingRequest) throw new SessionWatchError("WATCH_OUTCOME_UNKNOWN", `Session owner ended without a settled result for request ${pendingRequestId}; its outcome is unknown. Resume watching from the last cursor after recovery, and do not automatically replay the prompt.`);
	observation.missingRequest = pendingRequestId;
	if (pendingRequestId) return true;
	return await isSessionOpen(recordId);
}
async function isSessionOpen(recordId) {
	const record = await readSessionRecord(recordId);
	if (!record || record.acpxRecordId !== recordId) throw new SessionNotFoundError(recordId);
	return record.closed !== true;
}
function watchSession(options) {
	return { [Symbol.asyncIterator]() {
		const observation = {
			ownerKey: null,
			missingRequest: null
		};
		return watchSession$1({
			...options,
			continueWatching: (record, requestId) => continueWatching(record.acpxRecordId, requestId, observation)
		})[Symbol.asyncIterator]();
	} };
}
export { watchSession as t };

//# sourceMappingURL=watch-bQXyUy3z.js.map