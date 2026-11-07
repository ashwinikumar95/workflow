const fs = require("fs");
const path = require("path");
const git = require("./gitService");
const { buildAgentContainerSpec } = require("./containerSpec");
const config = require("../../config");
const { isReadOnlyMode, normalizeMode, validateModeArtifact } = require("./agentContract");

function classifyAgentTree(observed, mode) {
  const clean = Boolean(observed && observed.clean);
  const head = observed && observed.head;
  const preAgentSha = observed && observed.preAgentSha;
  const same = Boolean(head) && head === preAgentSha;
  const readOnly = isReadOnlyMode(normalizeMode(mode) || mode);
  const attemptStarted = Boolean(
    (observed && observed.hasReceipt) || (observed && observed.sdkStatus === "finished")
  );

  if (observed && observed.containerRunning) return { action: "wait" };

  if (readOnly) {
    if (!clean || !same) {
      return { action: "settle", branch: "false", reason: "plan-dirty" };
    }
    if (attemptStarted) {
      return { action: "settle", branch: "true", sha: head };
    }
    return { action: "start" };
  }

  const goodCommit =
    clean &&
    !same &&
    observed.descendant === true &&
    observed.diffEmpty === false;

  if (goodCommit) return { action: "settle", branch: "true", sha: head };
  if (!attemptStarted) return { action: "start" };
  if (!clean || (!same && !goodCommit) || same) {
    return { action: "settle", branch: "false", reason: "no-commit" };
  }
  return { action: "settle", branch: "false" };
}

function agentReceiptPath(worktreesDir, runId, nodeId) {
  const id = String(runId || "");
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Run id must be 24 hex characters");
  const node = typeof nodeId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(nodeId) ? nodeId : "";
  const file = node ? `${node}.json` : "agent-execution.json";
  return path.join(worktreesDir, id, "receipts", file);
}

function receiptPathForWorktree(worktreePath, nodeId) {
  if (!worktreePath) return "";
  const resolved = path.resolve(worktreePath);
  const match = /^([a-f0-9]{24})-[A-Za-z0-9_-]{1,64}$/.exec(path.basename(resolved));
  if (!match) return "";
  return agentReceiptPath(path.dirname(resolved), match[1], nodeId);
}

async function fileExists(file) {
  if (!file) return false;
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}

async function defaultInspect(worktreePath, preAgentSha, extra = {}) {
  const head = await git.revParse(worktreePath);
  const clean = await git.isClean(worktreePath);
  const descendant = await git.isAncestor(preAgentSha, head, worktreePath);
  const diffEmpty = await git.diffIsEmpty(preAgentSha, head, worktreePath);
  const runId = extra && extra.runId;
  const nodeId = extra && extra.nodeId;
  const nodeReceipt =
    runId && nodeId
      ? agentReceiptPath(path.dirname(path.resolve(worktreePath)), runId, nodeId)
      : receiptPathForWorktree(worktreePath, nodeId);
  const hasReceipt =
    (await fileExists(nodeReceipt)) ||
    (await fileExists(path.join(worktreePath, ".workflow", "agent-execution.json")));
  return {
    clean,
    head,
    preAgentSha,
    descendant,
    diffEmpty,
    hasReceipt,
    containerRunning: false,
    sdkStatus: null,
  };
}

function settlePayload(data, branch, extra) {
  return {
    runId: data.runId,
    workflowId: data.workflowId,
    nodeId: data.nodeId,
    kind: "agent",
    mode: data.mode,
    artifactDir: data.artifactDir,
    externalJobId: data.externalJobId,
    worktreePath: data.worktreePath,
    preAgentSha: data.preAgentSha,
    result: {
      branch,
      sha: extra && extra.sha ? extra.sha : null,
      status: extra && extra.status ? extra.status : null,
      reason: extra && extra.reason ? extra.reason : null,
    },
  };
}

/**
 * Classify the worktree before any container start. A retryable failure on a
 * still-clean tree is rethrown so BullMQ can use attempt 2.
 */
async function handleAgentJob(job, deps) {
  const data = job && job.data ? job.data : {};
  const inspect = deps.inspect || defaultInspect;
  const enqueueSettle = deps.enqueueSettle;
  const startContainer = deps.startContainer;
  const findEscape = deps.findEscapingSymlink || git.findEscapingSymlink;

  if (!enqueueSettle) throw new Error("enqueueSettle is required");

  const escaped = data.worktreePath ? await findEscape(data.worktreePath) : null;
  if (escaped) {
    await enqueueSettle(settlePayload(data, "false", { reason: "symlink" }));
    return { started: false };
  }

  const inspectExtra = { runId: data.runId, nodeId: data.nodeId };
  const observed = await inspect(data.worktreePath, data.preAgentSha, inspectExtra);
  if (deps.containerRunning) observed.containerRunning = true;
  const mode = normalizeMode(data.mode) || data.mode;
  const decision = classifyAgentTree(observed, mode);

  if (decision.action === "wait") {
    if (deps.waitForContainer) await deps.waitForContainer(data);
    const after = await inspect(data.worktreePath, data.preAgentSha, inspectExtra);
    const again = classifyAgentTree(after, mode);
    await enqueueSettle(settlePayload(data, again.branch === "true" ? "true" : "false", again));
    return { started: false };
  }

  if (decision.action === "settle") {
    await enqueueSettle(
      settlePayload(data, decision.branch === "true" ? "true" : "false", decision)
    );
    return { started: false };
  }

  const spec =
    data.runtime === "host"
      ? null
      : buildAgentContainerSpec({
          worktreePath: data.worktreePath,
          agentExecutionId: data.agentExecutionId,
          apiKey: config.cursorApiKey,
          model: config.cursorModel,
          egressHosts: deps.egressHosts || config.cursorEgressHosts,
          image: deps.image,
        });

  try {
    const result = await startContainer(spec, data);
    const afterEscape = await findEscape(data.worktreePath);
    if (afterEscape) {
      await enqueueSettle(settlePayload(data, "false", { reason: "symlink" }));
      return { started: true };
    }
    const after = await inspect(data.worktreePath, data.preAgentSha, inspectExtra);
    after.sdkStatus = result && result.status ? result.status : after.sdkStatus;
    if (result && result.receipt) after.hasReceipt = true;
    const done = classifyAgentTree(after, mode);
    let branch =
      !isReadOnlyMode(mode) &&
      result &&
      result.status === "finished" &&
      after.head === data.preAgentSha
        ? "false"
        : done.branch === "true"
          ? "true"
          : "false";
    let reason = done.reason;
    if (branch === "true" && mode) {
      const checked = validateModeArtifact(mode, data.artifactDir);
      if (!checked.ok) {
        branch = "false";
        reason = checked.reason || "invalid_artifact";
      }
    }
    await enqueueSettle(
      settlePayload(data, branch, { sha: after.head, status: result && result.status, reason })
    );
    return { started: true };
  } catch (err) {
    const after = await inspect(data.worktreePath, data.preAgentSha, inspectExtra);
    const retryable = Boolean(err && err.retryable);
    if (err && err.runtimeMissing) throw err;
    if (retryable && after.clean && after.head === data.preAgentSha) {
      throw err;
    }
    await enqueueSettle(settlePayload(data, "false", { reason: "agent-error" }));
    return { started: true, settled: "false" };
  }
}

module.exports = {
  classifyAgentTree,
  handleAgentJob,
  defaultInspect,
  agentReceiptPath,
  receiptPathForWorktree,
};
