const { calculateObjectSize } = require("bson");
const { v4: uuidv4 } = require("uuid");
const Workflow = require("../models/workflow");
const Run = require("../models/Run");
const config = require("../../config");
const nodes = require("../nodes");

const CONTEXT_LIMIT_BYTES = 256 * 1024;
const pipelineUpdate = { returnDocument: "after", updatePipeline: true };

const engine = {
  acquireExecutionClaim,
  renewExecutionClaim,
  persistRun,
  persistWaitingRun,
  beginResume,
  buildExecutionClaimRenewEveryMs,
  buildWaitFields,
  executeWorkflow,
  resumeWorkflow,
  getNextNode,
  executeWithRetry,
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

function preview(value) {
  const text = JSON.stringify(value);
  if (typeof text !== "string") return "";
  return text.slice(0, 200);
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
  return Run.findOneAndUpdate(
    holderFilter(runId, token),
    externalPipeline(setDoc, patch.external),
    pipelineUpdate
  );
}

function externalPipeline(setDoc, external) {
  const pipeline = [{ $set: setDoc }];
  if (external && typeof external === "object" && !Array.isArray(external)) {
    pipeline.push({
      $set: {
        external: {
          $mergeObjects: [{ $ifNull: ["$external", {}] }, { $literal: external }],
        },
      },
    });
  }
  return pipeline;
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

async function maybeNotifyRunFailure(workflowId, message) {
  const axios = require("axios");
  const url = config.slackWebhookUrl;
  if (!url) return;
  try {
    await axios.post(
      url,
      { text: `Workflow run failed (${String(workflowId)}): ${message}` },
      { timeout: 8000 }
    );
  } catch (e) {
    console.error("[executeWorkflow] Failure notify to Slack failed:", e.message);
  }
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

async function cleanupWorktree(runId) {
  try {
    const row = await Run.findById(runId);
    const external = row && row.external;
    if (!external || !external.worktreePath || !external.repoPath) return;
    const git = require("./gitService");
    await git.removeWorktree({
      repoPath: external.repoPath,
      worktreePath: external.worktreePath,
      worktreesDir: config.worktreesDir,
    });
  } catch (err) {
    console.error("[executeWorkflow] worktree remove failed:", err.message);
  }
}

async function walkClaimed(workflow, run, token, position, leaseMs) {
  let currentNode = position.node;
  let currentInput = position.input;
  let isFirstNode = true;
  let predecessorId = null;
  const externalState =
    run.external && typeof run.external === "object" && !Array.isArray(run.external)
      ? { ...run.external }
      : {};

  while (currentNode) {
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
      predecessorId,
      external: externalState,
      resumed,
      decision: resumed && run.approval ? run.approval.decision : undefined,
      completion: resumed ? run.wait.completion : undefined,
      checkpointExternal: async (external) => {
        const saved = await engine.persistRun(run._id, token, {
          context: currentInput,
          currentNodeId: currentNode.id,
          status: "running",
          external,
        });
        if (!saved) throw claimBusy();
        Object.assign(externalState, external);
      },
    };
    let output;
    let thrown = null;
    try {
      output = await executeWithRetry(currentNode, currentInput, 3, runState);
    } catch (err) {
      thrown = err;
    } finally {
      renewer.stop();
    }

    if (renewer.lost()) throw claimBusy();

    if (thrown) {
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
      await cleanupWorktree(run._id);
      await maybeNotifyRunFailure(workflow._id, thrown.message);
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
      if (output.kind === "agent" || output.kind === "playwright") {
        await enqueueExternalJob(saved, output);
      }
      return Run.findById(run._id);
    }

    const next = getNextNode(workflow, currentNode, output);
    const done = next == null;
    const saved = await engine.persistRun(run._id, token, {
      context: output,
      currentNodeId: next ? next.id : null,
      status: done ? "success" : "running",
      ended: done,
      log: {
        nodeId: currentNode.id,
        status: "success",
        input: preview(currentInput),
        output: preview(output),
        duration: Date.now() - started,
      },
    });
    if (!saved) throw claimBusy();

    predecessorId = currentNode.id;
    currentInput = output;
    currentNode = next;
  }

  console.log("Workflow completed:", workflow._id);
  return Run.findById(run._id);
}

module.exports = engine;
