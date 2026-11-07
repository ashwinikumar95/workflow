const fs = require("fs");
const path = require("path");
const git = require("./gitService");
const { buildAgentContainerSpec } = require("./containerSpec");
const config = require("../../config");

function classifyAgentTree(observed) {
  const clean = Boolean(observed && observed.clean);
  const head = observed && observed.head;
  const preAgentSha = observed && observed.preAgentSha;
  const same = Boolean(head) && head === preAgentSha;
  const goodCommit =
    clean &&
    !same &&
    observed.descendant === true &&
    observed.diffEmpty === false;

  if (observed && observed.containerRunning) return { action: "wait" };
  if (goodCommit) return { action: "settle", branch: "true", sha: head };
  if (!clean || (!same && !goodCommit)) return { action: "settle", branch: "false" };
  if (observed.sdkStatus === "finished" && same) return { action: "settle", branch: "false" };
  if (observed.hasReceipt && same) return { action: "settle", branch: "false" };
  if (clean && same && !observed.hasReceipt) return { action: "start" };
  return { action: "settle", branch: "false" };
}

async function defaultInspect(worktreePath, preAgentSha) {
  const head = await git.revParse(worktreePath);
  const clean = await git.isClean(worktreePath);
  const descendant = await git.isAncestor(preAgentSha, head, worktreePath);
  const diffEmpty = await git.diffIsEmpty(preAgentSha, head, worktreePath);
  let hasReceipt = false;
  try {
    await fs.promises.access(path.join(worktreePath, ".workflow", "agent-execution.json"));
    hasReceipt = true;
  } catch {
    hasReceipt = false;
  }
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

  const observed = await inspect(data.worktreePath, data.preAgentSha);
  if (deps.containerRunning) observed.containerRunning = true;
  const decision = classifyAgentTree(observed);

  if (decision.action === "wait") {
    if (deps.waitForContainer) await deps.waitForContainer(data);
    const after = await inspect(data.worktreePath, data.preAgentSha);
    const again = classifyAgentTree(after);
    await enqueueSettle(settlePayload(data, again.branch === "true" ? "true" : "false", again));
    return { started: false };
  }

  if (decision.action === "settle") {
    await enqueueSettle(
      settlePayload(data, decision.branch === "true" ? "true" : "false", decision)
    );
    return { started: false };
  }

  const spec = buildAgentContainerSpec({
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
    const after = await inspect(data.worktreePath, data.preAgentSha);
    after.sdkStatus = result && result.status ? result.status : after.sdkStatus;
    if (result && result.receipt) after.hasReceipt = true;
    const done = classifyAgentTree(after);
    const branch =
      result && result.status === "finished" && after.head === data.preAgentSha
        ? "false"
        : done.branch === "true"
          ? "true"
          : "false";
    await enqueueSettle(settlePayload(data, branch, { sha: after.head, status: result && result.status }));
    return { started: true };
  } catch (err) {
    const after = await inspect(data.worktreePath, data.preAgentSha);
    const retryable = Boolean(err && err.retryable);
    if (err && err.runtimeMissing) throw err;
    if (retryable && after.clean && after.head === data.preAgentSha) {
      throw err;
    }
    await enqueueSettle(settlePayload(data, "false", { reason: "agent-error" }));
    return { started: true, settled: "false" };
  }
}

module.exports = { classifyAgentTree, handleAgentJob, defaultInspect };
