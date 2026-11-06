const fs = require("fs");
const path = require("path");
const Run = require("../models/Run");
const TicketRun = require("../models/TicketRun");
const ResourceLock = require("../models/ResourceLock");
const git = require("./gitService");
const hostProcess = require("./hostProcess");
const resourceLocks = require("./resourceLocks");
const ticketState = require("./ticketState");

function processesOf(run, ticket) {
  const list = [];
  const external = run && run.external;
  if (external && Array.isArray(external.processes)) list.push(...external.processes);
  if (ticket && Array.isArray(ticket.processes)) list.push(...ticket.processes);
  return list.filter((entry) => entry && entry.pid);
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killRunProcesses(run, ticket, deps = {}) {
  const kill = deps.killTree || hostProcess.killTree;
  const recorded = processesOf(run, ticket);
  for (const entry of recorded) {
    if (isPidAlive(entry.pid)) await kill(entry.pid);
  }
  return recorded;
}

function worktreePathOf(ticket, run) {
  if (ticket && ticket.worktreePath) return ticket.worktreePath;
  const external = run && run.external;
  if (!external || typeof external !== "object") return "";
  if (typeof external.worktreePath === "string" && external.worktreePath) return external.worktreePath;
  const app = external.repos && external.repos.app;
  if (app && typeof app.worktreePath === "string") return app.worktreePath;
  const auto = external.repos && external.repos.automation;
  if (auto && typeof auto.worktreePath === "string") return auto.worktreePath;
  return "";
}

function checkpointShaOf(ticket, run, stage) {
  if (ticket && ticket.checkpointSha) return ticket.checkpointSha;
  const external = run && run.external;
  const role = external && external.repos && (external.repos.app || external.repos.automation);
  if (stage === "playwright" || stage === "baseline" || stage === "push") {
    return (
      (ticket && ticket.testedSha) ||
      (external && external.testedSha) ||
      (role && role.testedSha) ||
      ""
    );
  }
  return (external && external.preAgentSha) || (role && role.preAgentSha) || "";
}

async function inspectWorktree(worktreePath, checkpointSha, deps = {}) {
  const revParse = deps.revParse || git.revParse;
  const abbrevHead = deps.abbrevHead || git.abbrevHead;
  const dirtyFiles = deps.dirtyFiles || git.dirtyFiles;
  if (!worktreePath) {
    return { exists: false, clean: false, head: "", branch: "", dirty: [], headUnchanged: false };
  }
  try {
    await fs.promises.stat(worktreePath);
  } catch {
    return { exists: false, clean: false, head: "", branch: "", dirty: [], headUnchanged: false };
  }
  const [head, branch, dirty] = await Promise.all([
    revParse(worktreePath),
    abbrevHead(worktreePath),
    dirtyFiles(worktreePath),
  ]);
  const files = Array.isArray(dirty) ? dirty : [];
  return {
    exists: true,
    head,
    branch,
    dirty: files,
    clean: files.length === 0,
    headUnchanged: !checkpointSha || head === checkpointSha,
  };
}

async function markInterrupted(ticket, run, reason, details = {}) {
  if (ticket && ticketState.isAllowed(ticket.state, "interrupted")) {
    await ticketState.transition(ticket._id, ticket.state, "interrupted", {
      failureReason: reason,
      stage: ticket.stage,
      ...details,
    });
  } else if (ticket && ticket.state !== "interrupted") {
    await TicketRun.updateOne(
      { _id: ticket._id },
      { $set: { failureReason: reason, stage: ticket.stage || ticket.state } }
    );
  }
  if (run && run._id) {
    await Run.updateOne(
      { _id: run._id, status: { $nin: ["success", "cancelled"] } },
      { $set: { status: "interrupted", endedAt: new Date() } }
    );
    const slack = require("./slackService");
    await slack.emit(run._id, "interrupted", { reason, stage: ticket && ticket.stage });
  }
  if (typeof details.runCursor === "function") {
    // recovery of implementing must never call this; present only so tests can spy
  }
  return {
    ok: true,
    action: "interrupt",
    state: "interrupted",
    reason,
    cursorInvoked: false,
    worktreeKept: true,
    dirty: details.dirty || [],
    head: details.head || "",
    branch: details.branch || "",
  };
}

async function stashPlaywrightArtifacts(runId, worktreePath) {
  const config = require("../../config");
  if (!worktreePath) return;
  const src = path.join(worktreePath, "test-results");
  try {
    await fs.promises.stat(src);
  } catch {
    return;
  }
  const destBase = config.playwrightArtifactsDir || path.join(path.dirname(worktreePath), "artifacts");
  const dest = path.join(destBase, String(runId), "attempt-1-interrupted");
  await fs.promises.mkdir(dest, { recursive: true });
  await fs.promises.cp(src, dest, { recursive: true }).catch(() => {});
}

async function recoverTicket(ticket, deps = {}) {
  if (!ticket) return { ok: false, reason: "missing_ticket" };
  const run = deps.run || (ticket.runId ? await Run.findById(ticket.runId) : null);
  const stage = ticket.stage || ticket.state;
  await killRunProcesses(run, ticket, deps);

  if (typeof deps.jiraFingerprint === "function" && ticket.fingerprint) {
    const current = await deps.jiraFingerprint(ticket.jiraKey);
    if (current && current !== ticket.fingerprint) {
      return markInterrupted(ticket, run, "jira fingerprint changed");
    }
  }

  const worktreePath = worktreePathOf(ticket, run);
  const checkpointSha = checkpointShaOf(ticket, run, stage);
  const tree = await inspectWorktree(worktreePath, checkpointSha, deps);
  const runCursor = deps.runCursor;

  if (stage === "claimed") {
    return { ok: true, action: "resume", state: ticket.state, currentNodeId: run && run.currentNodeId };
  }

  if (stage === "planning") {
    if (tree.exists && tree.clean && tree.headUnchanged) {
      if (deps.manual && ticketState.isAllowed(ticket.state, "planning") && ticket.state === "interrupted") {
        await ticketState.transition(ticket._id, "interrupted", "planning");
      }
      return { ok: true, action: "replan", state: "planning", cursorInvoked: false };
    }
    return markInterrupted(ticket, run, "planning tree dirty or HEAD moved", {
      dirty: tree.dirty,
      head: tree.head,
      branch: tree.branch,
    });
  }

  if (stage === "awaiting_approval") {
    return { ok: true, action: "none", state: ticket.state };
  }

  if (stage === "queued" || stage === "acquireResources") {
    await resourceLocks.releaseByOwner(ticket.runId);
    if (ticket.state !== "queued" && ticketState.isAllowed(ticket.state, "queued")) {
      await ticketState.transition(ticket._id, ticket.state, "queued");
    }
    return { ok: true, action: "requeue", state: "queued" };
  }

  if (stage === "implementing") {
    if (typeof runCursor === "function") {
      // Cursor stages never auto-rerun. Tests spy this and assert it was not called.
    }
    if (deps.manual) {
      return {
        ok: true,
        action: "resume",
        resumeState: "implementing",
        currentNodeId: run && run.currentNodeId,
        cursorInvoked: false,
        worktreeKept: true,
        dirty: tree.dirty,
        head: tree.head,
      };
    }
    return markInterrupted(ticket, run, "killed during implementing", {
      dirty: tree.dirty,
      head: tree.head,
      branch: tree.branch,
    });
  }

  if (stage === "gates" || stage === "rules_review") {
    if (tree.exists && tree.clean && tree.headUnchanged) {
      return { ok: true, action: "rerun_gates", state: ticket.state, cursorInvoked: false };
    }
    return markInterrupted(ticket, run, "gates tree changed", {
      dirty: tree.dirty,
      head: tree.head,
      branch: tree.branch,
    });
  }

  if (stage === "playwright") {
    const testedSha = checkpointShaOf(ticket, run, "playwright") || tree.head;
    await stashPlaywrightArtifacts(ticket.runId, worktreePath);
    const portName = resourceLocks.portResourceForProfile(ticket.profileKey);
    if (ticket.lockToken && portName) {
      await resourceLocks.release(ticket.runId, ticket.lockToken, [portName]);
    } else if (portName) {
      const portLock = await ResourceLock.findById(portName).lean();
      if (portLock && portLock.owner === String(ticket.runId)) {
        await resourceLocks.release(portLock.owner, portLock.token, [portName]);
      }
    }
    const rerun = deps.rerunPlaywright || (async () => {});
    await rerun({
      runId: ticket.runId,
      testedSha,
      selection: ticket.selection,
      run,
      ticket,
    });
    return {
      ok: true,
      action: "rerun_playwright",
      testedSha,
      state: ticket.state,
      cursorInvoked: false,
    };
  }

  if (stage === "baseline") {
    const rerun = deps.rerunBaseline || (async () => {});
    await rerun({ runId: ticket.runId, ticket, run });
    return { ok: true, action: "rerun_baseline", state: ticket.state };
  }

  if (stage === "push") {
    const testedSha = checkpointShaOf(ticket, run, "push");
    const remoteSha = typeof deps.remoteBranchSha === "function" ? await deps.remoteBranchSha(ticket, run) : testedSha;
    if (testedSha && remoteSha === testedSha) {
      return { ok: true, action: "continue", state: ticket.state };
    }
    return markInterrupted(ticket, run, "push SHA mismatch");
  }

  if (stage === "pr_open") {
    if (typeof deps.lookupPr === "function") {
      const pr = await deps.lookupPr(ticket, run);
      if (pr && pr.url) {
        await TicketRun.updateOne({ _id: ticket._id }, { $set: { prUrl: pr.url } });
      }
    }
    return { ok: true, action: "continue", state: ticket.state };
  }

  if (stage === "jira_closeout") {
    return { ok: true, action: "continue", state: ticket.state };
  }

  if (stage === "verifying") {
    if (tree.exists && tree.clean && tree.headUnchanged) {
      return { ok: true, action: "rerun_gates", state: ticket.state };
    }
    return markInterrupted(ticket, run, "verifying tree changed", {
      dirty: tree.dirty,
      head: tree.head,
      branch: tree.branch,
    });
  }

  return { ok: true, action: "none", state: ticket.state };
}

async function recoverExpiredLocks(deps = {}) {
  const now = deps.now instanceof Date ? deps.now : new Date();
  const expired = await ResourceLock.find({ expiresAt: { $lte: now } }).lean();
  const released = [];
  for (const lock of expired) {
    let run = null;
    try {
      run = await Run.findById(lock.owner);
    } catch {
      run = null;
    }
    const ticket = await TicketRun.findOne({ runId: String(lock.owner) });
    await killRunProcesses(run, ticket, deps);
    const result = await ResourceLock.deleteOne({
      _id: lock._id,
      owner: lock.owner,
      token: lock.token,
      expiresAt: { $lte: now },
    });
    if (result.deletedCount) released.push(String(lock._id));
    if (ticket && !ticketState.isTerminal(ticket.state) && !deps.skipTicketRecovery) {
      await recoverTicket(ticket, { ...deps, run });
    }
  }
  return released;
}

async function recoverStale(deps = {}) {
  const released = await recoverExpiredLocks({ ...deps, skipTicketRecovery: true });
  const live = await TicketRun.find({
    state: { $nin: ticketState.TERMINAL_STATES },
  }).lean();
  const results = [];
  for (const ticket of live) {
    const run = await Run.findById(ticket.runId);
    const lock = await ResourceLock.findOne({ owner: String(ticket.runId) }).lean();
    const lockExpired = Boolean(lock && lock.expiresAt && lock.expiresAt.getTime() <= Date.now());
    const workerGone = !run || !["running", "waiting"].includes(run.status);
    if (!lockExpired && !workerGone && run && run.status === "waiting") continue;
    if (lockExpired || (workerGone && ["running", "interrupted"].includes(run && run.status))) {
      results.push(await recoverTicket(ticket, { ...deps, run }));
    }
  }
  return { released, results };
}

module.exports = {
  processesOf,
  isPidAlive,
  killRunProcesses,
  inspectWorktree,
  recoverTicket,
  recoverExpiredLocks,
  recoverStale,
};
