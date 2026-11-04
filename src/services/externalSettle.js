const Run = require("../models/Run");
const git = require("./gitService");
const { classifyAgentTree } = require("./agentAttempt");

function withBranch(data, branch, extra) {
  const result = { ...(data.result || {}), ...(extra || {}), branch };
  return { ...data, result };
}

/**
 * Re-check agent and Playwright evidence on the workflow worker.
 * The container exit code and `result.status === "finished"` are not authority.
 */
async function prepareExternalSettle(data) {
  if (!data || data.kind === "approval" || (data.kind !== "agent" && data.kind !== "playwright")) {
    return data;
  }
  const run = data.runId ? await Run.findById(data.runId) : null;
  const external = (run && run.external) || {};

  if (data.kind === "agent") {
    const worktree = data.worktreePath || external.worktreePath;
    const preAgentSha = data.preAgentSha || external.preAgentSha;
    if (!worktree || !preAgentSha) return withBranch(data, "false");
    let observed;
    try {
      const head = await git.revParse(worktree);
      const clean = await git.isClean(worktree);
      const descendant = await git.isAncestor(preAgentSha, head, worktree);
      const diffEmpty = await git.diffIsEmpty(preAgentSha, head, worktree);
      observed = {
        clean,
        head,
        preAgentSha,
        descendant,
        diffEmpty,
        hasReceipt: false,
        containerRunning: false,
        sdkStatus: data.result && data.result.status,
      };
    } catch {
      return withBranch(data, "false");
    }
    const decision = classifyAgentTree(observed);
    const branch = decision.branch === "true" ? "true" : "false";
    return withBranch(data, branch, { sha: decision.sha || observed.head, status: observed.sdkStatus });
  }

  const worktree = data.worktreePath || external.worktreePath;
  const tested = external.testedSha || data.testedSha;
  let head = null;
  try {
    if (worktree) head = await git.revParse(worktree);
  } catch {
    head = null;
  }
  const reported = data.result || {};
  const shaOk = Boolean(tested) && head === tested && (reported.testedSha == null || reported.testedSha === tested);
  const passed = reported.status === "passed" && reported.reportPresent === true && shaOk;
  let status = reported.status;
  if (status !== "timed-out" && status !== "bootstrap-failed" && status !== "failed" && status !== "passed") {
    status = "failed";
  }
  if (!passed && status === "passed") status = "failed";
  if (!shaOk && reported.status === "passed") status = "failed";
  const entry = {
    status: passed ? "passed" : status,
    reportPresent: reported.reportPresent === true,
    testedSha: tested || reported.testedSha || null,
    failureClass: passed
      ? null
      : reported.failureClass || (reported.reportPresent === true ? "tests" : "missing-report"),
  };
  return {
    ...withBranch(data, passed ? "true" : "false", { status: entry.status, reportPresent: entry.reportPresent }),
    playwrightByNode: { nodeId: data.nodeId, entry },
  };
}

module.exports = { prepareExternalSettle };
