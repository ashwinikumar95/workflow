const path = require("path");
const { calculateObjectSize } = require("bson");
const { v4: uuidv4 } = require("uuid");
const Workflow = require("../models/workflow");
const Run = require("../models/Run");
const TicketRun = require("../models/TicketRun");
const config = require("../../config");
const nodes = require("../nodes");
const ticketState = require("./ticketState");
const { cancelledError } = require("./runControl");

const CONTEXT_LIMIT_BYTES = 256 * 1024;
const pipelineUpdate = { returnDocument: "after", updatePipeline: true };

const engine = {
  acquireExecutionClaim,
  renewExecutionClaim,
  persistRun,
  branchFailureStamp,
  persistWaitingRun,
  beginResume,
  buildExecutionClaimRenewEveryMs,
  buildWaitFields,
  executeWorkflow,
  resumeWorkflow,
  getNextNode,
  executeWithRetry,
  carryForward,
  preview,
};

function claimBusy() {
  const err = new Error("RUN_CLAIM_BUSY");
  err.code = "RUN_CLAIM_BUSY";
  return err;
}

function resolveJobId(jobId) {
  if (jobId != null && String(jobId).trim() !== "") {
    return String(jobId);
  }
  return uuidv4();
}

const PREVIEW_SKIP = new Set([
  "analysis",
  "artifactDir",
  "description",
  "descriptionText",
  "fingerprint",
  "issueId",
  "jira",
  "plan",
  "profileKey",
  "prompt",
  "repoPath",
  "rulesApplied",
  "rulesManifest",
  "source",
  "worktreePath",
]);

function compactPreview(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return value;
  const out = {};
  const jira = value.jira && typeof value.jira === "object" ? value.jira : {};
  if (typeof value.issueKey === "string" && value.issueKey) out.issueKey = value.issueKey;
  else if (typeof jira.key === "string" && jira.key) out.issueKey = jira.key;
  const summary = value.summary || jira.summary;
  if (typeof summary === "string" && summary) out.summary = summary.slice(0, 120);
  if (value.branch === true || value.branch === "true" || value.branch === false || value.branch === "false") {
    out.branch = String(value.branch);
  }
  if (value.reason != null && value.reason !== "") out.reason = String(value.reason).slice(0, 80);
  if (value.message != null && value.message !== "") out.message = String(value.message).slice(0, 80);
  if (typeof value.prUrl === "string" && value.prUrl) out.prUrl = value.prUrl;
  if (typeof value.agentMode === "string" && value.agentMode) out.agentMode = value.agentMode;
  if (value.guardFailed) out.guardFailed = true;
  if (typeof value.prompt === "string" && value.prompt.trim()) {
    out.prompt = value.prompt.trim().slice(0, 80);
  }
  if (value.plan && typeof value.plan === "object" && value.plan.approach) {
    out.plan = String(value.plan.approach).slice(0, 80);
  }
  for (const [key, val] of Object.entries(value)) {
    if (key in out || PREVIEW_SKIP.has(key) || val == null || typeof val === "object") continue;
    const text = String(val);
    out[key] = text.length > 80 ? text.slice(0, 80) : val;
  }
  return out;
}

function preview(value) {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value !== "object") {
    const text = String(value);
    return text.length <= 200 ? text : text.slice(0, 200);
  }
  const compact = compactPreview(value);
  const keys = Object.keys(compact);
  while (keys.length) {
    const text = JSON.stringify(compact);
    if (typeof text === "string" && text.length <= 200) return text;
    const drop = keys.pop();
    delete compact[drop];
  }
  const fallback = JSON.stringify(value);
  if (typeof fallback !== "string") return "";
  return fallback.slice(0, 200);
}

function assertContextLimit(context) {
  if (context === undefined) return;
  const size = calculateObjectSize({ context });
  if (size > CONTEXT_LIMIT_BYTES) {
    throw new Error("CONTEXT_TOO_LARGE");
  }
}

function buildExecutionClaimRenewEveryMs(leaseMs) {
  if (!Number.isInteger(leaseMs) || leaseMs <= 0) {
    throw new Error(
      "execution claim renew interval must be a positive integer strictly below the lease"
    );
  }
  const every = Math.floor(leaseMs / 2);
  if (!Number.isInteger(every) || every <= 0 || every >= leaseMs) {
    throw new Error(
      "execution claim renew interval must be a positive integer strictly below the lease"
    );
  }
  return every;
}

function claimFilter(runId) {
  return {
    _id: runId,
    $expr: {
      $or: [
        { $eq: [{ $ifNull: ["$executionClaimExpiresAt", null] }, null] },
        { $lte: ["$executionClaimExpiresAt", "$$NOW"] },
      ],
    },
  };
}

function holderFilter(runId, token) {
  return {
    _id: runId,
    executionClaim: token,
    $expr: { $gt: ["$executionClaimExpiresAt", "$$NOW"] },
  };
}

async function acquireExecutionClaim(runId, leaseMs) {
  const token = uuidv4();
  return Run.findOneAndUpdate(
    claimFilter(runId),
    [
      {
        $set: {
          executionClaim: token,
          executionClaimExpiresAt: { $add: ["$$NOW", leaseMs] },
        },
      },
    ],
    pipelineUpdate
  );
}

async function renewExecutionClaim(runId, token, leaseMs) {
  return Run.findOneAndUpdate(
    holderFilter(runId, token),
    [
      {
        $set: {
          executionClaimExpiresAt: { $add: ["$$NOW", leaseMs] },
        },
      },
    ],
    pipelineUpdate
  );
}

async function persistRun(runId, token, patch) {
  assertContextLimit(patch.context);
  const leaseMs = config.executionClaimLeaseMs;
  const setDoc = {
    context: { $literal: patch.context === undefined ? null : patch.context },
    currentNodeId: { $literal: patch.currentNodeId ?? null },
    status: patch.status,
    executionClaimExpiresAt: { $add: ["$$NOW", leaseMs] },
  };
  if (patch.ended) {
    setDoc.endedAt = "$$NOW";
  }
  if (patch.log) {
    setDoc.logs = {
      $concatArrays: [{ $ifNull: ["$logs", []] }, [{ $literal: patch.log }]],
    };
  }
  if (patch.failure) {
    setDoc.failure = { $ifNull: ["$failure", { $literal: patch.failure }] };
  }
  const saved = await Run.findOneAndUpdate(
    holderFilter(runId, token),
    externalPipeline(setDoc, patch.external),
    pipelineUpdate
  );
  if (saved && patch.status === "failed") {
    await ticketState.markEnded(saved._id, "failed", {
      failureReason: patch.log && patch.log.error,
    });
  }
  if (saved && patch.failure && patch.failure.nodeId && patch.failure.reason) {
    const TicketRun = require("../models/TicketRun");
    const failureReason = `${patch.failure.nodeId}: ${patch.failure.reason}`;
    await TicketRun.updateOne(
      {
        runId: String(saved._id),
        $or: [{ failureReason: { $exists: false } }, { failureReason: null }, { failureReason: "" }],
      },
      { $set: { failureReason } }
    );
  }
  return saved;
}

function branchFailureStamp(nodeId, output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  if (output.branch !== "false" && output.branch !== false) return null;
  const reason = typeof output.reason === "string" ? output.reason.trim() : "";
  if (!reason) return null;
  return { nodeId, reason };
}

function externalPipeline(setDoc, external) {
  const pipeline = [{ $set: setDoc }];
  if (!external || typeof external !== "object" || Array.isArray(external)) return pipeline;
  const repos = external.repos;
  const rest = { ...external };
  delete rest.repos;
  if (Object.keys(rest).length > 0) {
    pipeline.push({
      $set: {
        external: {
          $mergeObjects: [{ $ifNull: ["$external", {}] }, { $literal: rest }],
        },
      },
    });
  }
  if (repos && typeof repos === "object" && !Array.isArray(repos)) {
    for (const role of ["app", "automation"]) {
      const entry = repos[role];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      pipeline.push({
        $set: {
          [`external.repos.${role}`]: {
            $mergeObjects: [
              { $ifNull: [`$external.repos.${role}`, {}] },
              { $literal: entry },
            ],
          },
        },
      });
    }
  }
  return pipeline;
}

function cloneExternal(external) {
  if (!external || typeof external !== "object" || Array.isArray(external)) return {};
  const source = typeof external.toObject === "function" ? external.toObject() : external;
  const copy = { ...source };
  if (source.repos && typeof source.repos === "object" && !Array.isArray(source.repos)) {
    copy.repos = {};
    for (const role of Object.keys(source.repos)) {
      const entry = source.repos[role];
      copy.repos[role] =
        entry && typeof entry === "object" && !Array.isArray(entry) ? { ...entry } : entry;
    }
  }
  return copy;
}

function replaceExternal(target, external) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, cloneExternal(external));
}

const NODE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const RUN_ID_PATTERN = /^[a-f0-9]{24}$/;
const WAIT_KINDS = new Set(["approval", "agent", "playwright"]);

function buildWaitFields(runId, nodeId, kind) {
  const id = String(runId);
  if (!RUN_ID_PATTERN.test(id)) {
    throw new Error("Run id must be 24 hex characters");
  }
  if (typeof nodeId !== "string" || !NODE_ID_PATTERN.test(nodeId)) {
    throw new Error("Node id must match ^[A-Za-z0-9_-]{1,64}$");
  }
  if (!WAIT_KINDS.has(kind)) {
    throw new Error("Unknown wait kind");
  }
  const externalJobId = `${kind}-${id}-${nodeId}`;
  const resumeJobId = `resume-${kind}-${id}-${nodeId}`;
  if (!/^[A-Za-z0-9_-]+$/.test(externalJobId) || !/^[A-Za-z0-9_-]+$/.test(resumeJobId)) {
    throw new Error("Job id must match ^[A-Za-z0-9_-]+$");
  }
  return {
    kind,
    nodeId,
    state: "pending",
    externalJobId,
    resumeJobId,
  };
}

async function persistWaitingRun(runId, token, patch) {
  assertContextLimit(patch.context);
  const setDoc = {
    status: "waiting",
    context: { $literal: patch.context === undefined ? null : patch.context },
    currentNodeId: { $literal: patch.currentNodeId ?? null },
    executionClaim: null,
    executionClaimExpiresAt: null,
    wait: { $literal: patch.wait },
    approval: null,
    pendingResume: null,
  };
  if (patch.log) {
    setDoc.logs = {
      $concatArrays: [{ $ifNull: ["$logs", []] }, [{ $literal: patch.log }]],
    };
  }
  return Run.findOneAndUpdate(
    holderFilter(runId, token),
    externalPipeline(setDoc, patch.external),
    pipelineUpdate
  );
}

async function beginResume(runId, resumeJobId, leaseMs) {
  const token = uuidv4();
  const ms = leaseMs == null ? config.executionClaimLeaseMs : leaseMs;
  return Run.findOneAndUpdate(
    {
      _id: runId,
      status: "waiting",
      "wait.state": "completing",
      "wait.resumeJobId": resumeJobId,
      executionClaim: null,
    },
    [
      {
        $set: {
          executionClaim: token,
          executionClaimExpiresAt: { $add: ["$$NOW", ms] },
          status: "running",
          wait: {
            $mergeObjects: [{ $ifNull: ["$wait", {}] }, { state: "resumed" }],
          },
        },
      },
    ],
    pipelineUpdate
  );
}

function createClaimRenewer(runId, token, leaseMs) {
  const every = buildExecutionClaimRenewEveryMs(leaseMs);
  let stopped = false;
  let lost = false;
  let failures = 0;
  let timer = null;

  const schedule = (ms) => {
    if (stopped || lost) return;
    timer = setTimeout(() => {
      void tick();
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
  };

  async function tick() {
    if (stopped || lost) return;
    try {
      const updated = await engine.renewExecutionClaim(runId, token, leaseMs);
      if (stopped || lost) return;
      if (updated == null) {
        lost = true;
        return;
      }
      failures = 0;
      schedule(every);
    } catch (err) {
      if (stopped || lost) return;
      if (failures < 1) {
        failures += 1;
        schedule(every);
      }
    }
  }

  schedule(every);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    lost() {
      return lost;
    },
  };
}

function isWaitControl(node, output) {
  if (!node || !["approval", "cursorAgent", "playwright"].includes(node.type)) return false;
  return Boolean(
    output &&
      typeof output === "object" &&
      output.control === "wait" &&
      WAIT_KINDS.has(output.kind)
  );
}

function approvalResumeState(run, node) {
  if (!node || node.type !== "approval" || !run || !run.wait) return undefined;
  if (run.wait.state !== "resumed" || run.wait.nodeId !== node.id) return undefined;
  const decision = run.approval && run.approval.decision;
  if (decision !== "approved" && decision !== "rejected") return undefined;
  return { decision };
}

function attemptsFor(node) {
  const raw = node && node.config && node.config.retries;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1) return raw;
  return 3;
}

async function executeWithRetry(node, input, retries = 3, runState) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      const result = await nodes.executeNode(node, input, runState);
      if (isWaitControl(node, result)) return result;
      return result;
    } catch (err) {
      if (err && err.code === "RUN_CLAIM_BUSY") throw err;
      lastError = err;
      console.log(`Retry ${i + 1} failed for node ${node.id}`);
    }
  }
  throw lastError;
}

function carryForward(previous, output) {
  if (output && typeof output === "object" && !Array.isArray(output)) return output;
  const base =
    previous && typeof previous === "object" && !Array.isArray(previous)
      ? { ...previous }
      : previous === undefined
        ? {}
        : { payload: previous };
  if (output === true || output === false) {
    base.branch = output ? "true" : "false";
    return base;
  }
  if (output !== undefined) base.payload = output;
  return base;
}

function getNextNode(workflow, currentNode, result) {
  const edges = workflow.edges.filter((e) => e.from === currentNode.id);
  if (edges.length === 0) return null;

  if (edges.length === 1) {
    return workflow.nodes.find((n) => n.id === edges[0].to);
  }

  let condition;
  if (result === true) {
    condition = "true";
  } else if (isBranchObject(result)) {
    if (result.branch === "true" || result.branch === "false") {
      condition = result.branch;
    } else {
      throw new Error(
        'Object results with multiple outgoing edges require branch "true" or "false"'
      );
    }
  } else {
    condition = "false";
  }

  const edge = edges.find((e) => e.condition === condition);
  if (!edge) {
    throw new Error(
      "Branching requires two outgoing edges labeled true and false"
    );
  }
  const next = workflow.nodes.find((n) => n.id === edge.to);
  if (!next) {
    throw new Error("Branch edge points to unknown node");
  }
  return next;
}

function isBranchObject(result) {
  return result !== null && typeof result === "object";
}

function findStartNode(workflow) {
  return workflow.nodes.find(
    (n) => !workflow.edges.some((e) => e.to === n.id)
  );
}

function positionFromRun(workflow, run, jobInput) {
  if (!run.currentNodeId) {
    const start = findStartNode(workflow);
    if (!start) throw new Error("No start node found");
    return { node: start, input: jobInput };
  }
  const node = workflow.nodes.find((n) => n.id === run.currentNodeId);
  if (!node) throw new Error("Checkpoint node not found");
  const input =
    run.context !== undefined && run.context !== null ? run.context : jobInput;
  return { node, input };
}

async function loadOrCreateRun(workflowId, jobId) {
  const existing = await Run.findOne({ jobId });
  if (existing) return existing;
  try {
    return await Run.create({
      workflowId,
      jobId,
      status: "running",
      startedAt: new Date(),
      logs: [],
    });
  } catch (err) {
    if (err && err.code === 11000) {
      const again = await Run.findOne({ jobId });
      if (again) return again;
    }
    throw err;
  }
}

async function maybeNotifyRunFailure(runId, message) {
  const slack = require("./slackService");
  await slack.emit(runId, slack.typeFromFailure(message), {
    reason: message,
  });
}

function stageForNode(node) {
  if (!node) return "";
  if (node.config && typeof node.config.ticketStage === "string" && node.config.ticketStage) {
    return node.config.ticketStage;
  }
  switch (node.type) {
    case "jiraUpdate":
      return node.config && node.config.action === "review" ? "jira_closeout" : "claimed";
    case "gitBranch":
      return "claimed";
    case "cursorAgent": {
      const mode = node.config && node.config.mode;
      if (mode === "plan") return "planning";
      if (mode === "review") return "rules_review";
      return "implementing";
    }
    case "approval":
      return "awaiting_approval";
    case "testSelect":
      return "verifying";
    case "playwright":
      return "playwright";
    case "githubPr":
      return "pr_open";
    default:
      return "";
  }
}

function stateForStage(stage) {
  switch (stage) {
    case "claimed":
      return "claimed";
    case "planning":
      return "planning";
    case "awaiting_approval":
      return "awaiting_approval";
    case "queued":
    case "acquireResources":
      return "queued";
    case "implementing":
      return "implementing";
    case "playwright":
    case "gates":
    case "rules_review":
    case "baseline":
    case "verifying":
      return "verifying";
    case "pr_open":
    case "push":
      return "pr_open";
    case "blocked":
      return "blocked";
    case "rejected":
      return "rejected";
    case "completed":
    case "jira_closeout":
      return "completed";
    default:
      return "";
  }
}

async function isRunCancelled(runId) {
  const ticket = await TicketRun.findOne({ runId: String(runId) }).select("state").lean();
  if (ticket && ticket.state === "cancelled") return true;
  const row = await Run.findById(runId).select("status").lean();
  return Boolean(row && row.status === "cancelled");
}

async function persistCancelled(runId, token, patch) {
  const saved = await engine.persistRun(runId, token, {
    context: patch.context,
    currentNodeId: patch.currentNodeId ?? null,
    status: "cancelled",
    ended: true,
    log: patch.log,
  });
  if (!saved) throw claimBusy();
  const slack = require("./slackService");
  await slack.emit(runId, "cancelled", { reason: "cancelled" });
  return Run.findById(runId);
}

async function syncTicketStage(run, node) {
  const ticket = await TicketRun.findOne({ runId: String(run._id) });
  if (!ticket) return null;
  if (ticket.state === "cancelled") throw cancelledError();
  const stage = stageForNode(node);
  if (stage && stage !== ticket.stage) {
    await TicketRun.updateOne(
      { _id: ticket._id, state: { $ne: "cancelled" } },
      { $set: { stage } }
    );
  }
  const nextState = stateForStage(stage);
  if (nextState && nextState !== ticket.state && ticketState.isAllowed(ticket.state, nextState)) {
    await ticketState.transition(ticket._id, ticket.state, nextState, { stage: stage || ticket.stage });
  }
  const latest = await TicketRun.findById(ticket._id);
  if (latest && latest.state === "cancelled") throw cancelledError();
  return latest;
}

async function executeWorkflow(workflowId, inputData = {}, jobId) {
  const resolvedJobId = resolveJobId(jobId);
  console.log(
    "[executeWorkflow] Executing workflow:",
    String(workflowId),
    "jobId:",
    resolvedJobId
  );

  const workflow = await Workflow.findById(workflowId);
  if (!workflow) throw new Error("Workflow not found");
  if (workflow.status !== "published") {
    throw new Error("Workflow not published");
  }

  const run = await loadOrCreateRun(workflowId, resolvedJobId);
  if (run.status === "success") return run;
  if (run.status === "waiting") return run;
  if (run.status === "cancelled") return run;
  if (run.status === "interrupted") return run;

  const leaseMs = config.executionClaimLeaseMs;
  const claimed = await engine.acquireExecutionClaim(run._id, leaseMs);
  if (!claimed) throw claimBusy();
  const token = claimed.executionClaim;

  let position;
  try {
    position = positionFromRun(workflow, claimed, inputData);
  } catch (err) {
    const failed = await engine.persistRun(run._id, token, {
      context: inputData,
      currentNodeId: null,
      status: "failed",
      ended: true,
      log: { status: "failed", error: err.message },
    });
    if (!failed) throw claimBusy();
    throw err;
  }

  if (await isRunCancelled(claimed._id)) {
    return persistCancelled(claimed._id, token, {
      context: inputData,
      currentNodeId: position.node ? position.node.id : claimed.currentNodeId,
      log: { status: "cancelled", error: "cancelled" },
    });
  }

  return walkClaimed(workflow, claimed, token, position, leaseMs);
}

async function resumeWorkflow(data, jobId) {
  const runId = data && data.runId;
  if (!runId) return null;
  const existing = await Run.findById(runId);
  if (!existing) return null;

  const leaseMs = config.executionClaimLeaseMs;
  const begun = await engine.beginResume(existing._id, String(jobId), leaseMs);
  if (!begun) return Run.findById(existing._id);

  const workflow = await Workflow.findById(begun.workflowId);
  if (!workflow) throw new Error("Workflow not found");
  if (workflow.status !== "published") throw new Error("Workflow not published");

  let position;
  try {
    position = positionFromRun(workflow, begun, data && data.input);
  } catch (err) {
    const failed = await engine.persistRun(begun._id, begun.executionClaim, {
      context: begun.context,
      currentNodeId: begun.currentNodeId,
      status: "failed",
      ended: true,
      log: { status: "failed", error: err.message },
    });
    if (!failed) throw claimBusy();
    throw err;
  }

  return walkClaimed(workflow, begun, begun.executionClaim, position, leaseMs);
}

async function enqueueExternalJob(saved, output) {
  try {
    if (output.kind === "agent") {
      const { enqueueAgent } = require("./cursorAgentService");
      await enqueueAgent(output.job);
    } else if (output.kind === "playwright") {
      const { enqueueSuite } = require("./playwrightService");
      await enqueueSuite(output.job);
    } else {
      return;
    }
    await Run.updateOne(
      { _id: saved._id, "wait.externalEnqueuedAt": null },
      { $set: { "wait.externalEnqueuedAt": new Date() } }
    );
  } catch (err) {
    const message = err && err.message ? String(err.message) : "";
    if (/already exists/i.test(message)) {
      await Run.updateOne(
        { _id: saved._id, "wait.externalEnqueuedAt": null },
        { $set: { "wait.externalEnqueuedAt": new Date() } }
      );
      return;
    }
    console.error("[executeWorkflow] external enqueue failed:", message);
  }
}

function worktreeTargets(external) {
  const targets = [];
  const push = (entry) => {
    if (!entry || !entry.worktreePath || !entry.repoPath) return;
    const resolved = path.resolve(entry.worktreePath);
    if (targets.some((item) => item.resolved === resolved)) return;
    targets.push({
      resolved,
      worktreePath: entry.worktreePath,
      repoPath: entry.repoPath,
    });
  };
  if (external && typeof external === "object") {
    push(external);
    if (external.repos && typeof external.repos === "object") {
      for (const entry of Object.values(external.repos)) push(entry);
    }
  }
  return targets;
}

async function cleanupWorktree(runId, workflow) {
  const git = require("./gitService");
  if (git.keepsWorktreeOnFailure(workflow)) return;
  try {
    const row = await Run.findById(runId);
    for (const target of worktreeTargets(row && row.external)) {
      try {
        await git.removeWorktree({
          repoPath: target.repoPath,
          worktreePath: target.worktreePath,
          worktreesDir: config.worktreesDir,
        });
      } catch (err) {
        console.error("[executeWorkflow] worktree remove failed:", err.message);
      }
    }
  } catch (err) {
    console.error("[executeWorkflow] worktree remove failed:", err.message);
  }
}

async function walkClaimed(workflow, run, token, position, leaseMs) {
  let currentNode = position.node;
  let currentInput = position.input;
  let isFirstNode = true;
  let predecessorId = null;
  const externalState = cloneExternal(run.external);

  while (currentNode) {
    if (await isRunCancelled(run._id)) {
      return persistCancelled(run._id, token, {
        context: currentInput,
        currentNodeId: currentNode.id,
        log: { nodeId: currentNode.id, status: "cancelled", error: "cancelled" },
      });
    }
    try {
      await syncTicketStage(run, currentNode);
    } catch (err) {
      if (err && err.code === "RUN_CANCELLED") {
        return persistCancelled(run._id, token, {
          context: currentInput,
          currentNodeId: currentNode.id,
          log: { nodeId: currentNode.id, status: "cancelled", error: "cancelled" },
        });
      }
      throw err;
    }

    if (!isFirstNode) {
      const renewed = await engine.renewExecutionClaim(run._id, token, leaseMs);
      if (!renewed) throw claimBusy();
    }
    isFirstNode = false;

    const cursor = await engine.persistRun(run._id, token, {
      context: currentInput,
      currentNodeId: currentNode.id,
      status: "running",
    });
    if (!cursor) throw claimBusy();

    const renewer = createClaimRenewer(run._id, token, leaseMs);
    const started = Date.now();
    const resumed = Boolean(
      run.wait && run.wait.state === "resumed" && run.wait.nodeId === currentNode.id
    );
    const runState = {
      runId: String(run._id),
      workflowId: String(workflow._id),
      nodeId: currentNode.id,
      workflow,
      node: currentNode,
      context: currentInput,
      predecessorId,
      external: externalState,
      resumed,
      decision: resumed && run.approval ? run.approval.decision : undefined,
      approval: resumed ? run.approval : undefined,
      wait: run.wait,
      completion: resumed ? run.wait.completion : undefined,
      checkpointExternal: async (external) => {
        const saved = await engine.persistRun(run._id, token, {
          context: currentInput,
          currentNodeId: currentNode.id,
          status: "running",
          external,
        });
        if (!saved) throw claimBusy();
        if (saved.external && typeof saved.external === "object") {
          replaceExternal(externalState, saved.external);
        }
      },
    };
    let output;
    let thrown = null;
    try {
      output = await executeWithRetry(
        currentNode,
        currentInput,
        attemptsFor(currentNode),
        runState
      );
    } catch (err) {
      thrown = err;
    } finally {
      renewer.stop();
    }

    if (renewer.lost()) throw claimBusy();

    if (thrown) {
      if (thrown.code === "RUN_CANCELLED" || (await isRunCancelled(run._id))) {
        return persistCancelled(run._id, token, {
          context: currentInput,
          currentNodeId: currentNode.id,
          log: {
            nodeId: currentNode.id,
            status: "cancelled",
            error: thrown.code === "RUN_CANCELLED" ? "cancelled" : thrown.message,
            input: preview(currentInput),
          },
        });
      }
      const failed = await engine.persistRun(run._id, token, {
        context: currentInput,
        currentNodeId: currentNode.id,
        status: "failed",
        ended: true,
        log: {
          nodeId: currentNode.id,
          status: "failed",
          error: thrown.message,
          input: preview(currentInput),
        },
      });
      if (!failed) throw claimBusy();
      await cleanupWorktree(run._id, workflow);
      await maybeNotifyRunFailure(run._id, thrown.message);
      throw thrown;
    }

    if (isWaitControl(currentNode, output)) {
      let wait;
      try {
        wait = engine.buildWaitFields(run._id, currentNode.id, output.kind);
      } catch (err) {
        const failed = await engine.persistRun(run._id, token, {
          context: currentInput,
          currentNodeId: currentNode.id,
          status: "failed",
          ended: true,
          log: {
            nodeId: currentNode.id,
            status: "failed",
            error: err.message,
            input: preview(currentInput),
          },
        });
        if (!failed) throw claimBusy();
        throw err;
      }
      if (output.job && (output.kind === "agent" || output.kind === "playwright")) {
        wait.job = output.job;
        wait.externalEnqueuedAt = null;
      }
      const saved = await engine.persistWaitingRun(run._id, token, {
        context: output.output,
        currentNodeId: currentNode.id,
        wait,
        external: output.external,
        log: {
          nodeId: currentNode.id,
          status: "waiting",
          input: preview(currentInput),
          output: preview(output.output),
          duration: Date.now() - started,
        },
      });
      if (!saved) throw claimBusy();
      if (output.kind === "approval") {
        const slack = require("./slackService");
        const plan =
          output.output && output.output.plan && typeof output.output.plan === "object"
            ? output.output.plan
            : {};
        const questions = Array.isArray(plan.questions)
          ? plan.questions.filter((question) => typeof question === "string" && question.trim())
          : [];
        const askQuestions = currentNode.id === "approvePlan" && questions.length > 0;
        await slack.emit(run._id, "waiting_for_approval", {
          nodeId: currentNode.id,
          stage: "awaiting_approval",
          reason: askQuestions
            ? `waiting for approval (${questions.length} question${questions.length === 1 ? "" : "s"} need answers)`
            : "waiting for approval",
        });
      }
      if (output.kind === "agent" || output.kind === "playwright") {
        await enqueueExternalJob(saved, output);
      }
      return Run.findById(run._id);
    }

    const next = getNextNode(workflow, currentNode, output);
    const done = next == null;
    const nextInput = carryForward(currentInput, output);
    const failure = branchFailureStamp(currentNode.id, output);
    const saved = await engine.persistRun(run._id, token, {
      context: nextInput,
      currentNodeId: next ? next.id : null,
      status: done ? "success" : "running",
      ended: done,
      failure: failure || undefined,
      log: {
        nodeId: currentNode.id,
        status: "success",
        ...(failure ? { error: failure.reason } : {}),
        input: preview(currentInput),
        output: preview(output),
        duration: Date.now() - started,
      },
    });
    if (!saved) throw claimBusy();

    predecessorId = currentNode.id;
    currentInput = nextInput;
    currentNode = next;
  }

  console.log("Workflow completed:", workflow._id);
  return Run.findById(run._id);
}

module.exports = engine;
