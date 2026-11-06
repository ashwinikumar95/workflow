const Run = require("../models/Run");

const pipelineUpdate = { returnDocument: "after", updatePipeline: true };

let enqueueImpl = defaultEnqueue;

function jobAlreadyExists(err) {
  const message = err && err.message ? String(err.message) : "";
  return /already exists/i.test(message);
}

function setResumeEnqueue(fn) {
  enqueueImpl = typeof fn === "function" ? fn : defaultEnqueue;
}

async function defaultEnqueue(run) {
  const { enqueueWorkflowJob, RESUME_JOB_NAME } = require("./enqueueWorkflowJob");
  const payload = run.pendingResume && run.pendingResume.payload;
  const input =
    payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  await enqueueWorkflowJob(run.workflowId, input, {
    jobName: RESUME_JOB_NAME,
    jobId: run.pendingResume.resumeJobId,
    runId: String(run._id),
    startNodeId: run.wait && run.wait.nodeId,
  });
}

async function stampEnqueued(runId, resumeJobId) {
  await Run.updateOne(
    {
      _id: runId,
      "pendingResume.resumeJobId": resumeJobId,
      "pendingResume.enqueuedAt": null,
    },
    { $set: { "pendingResume.enqueuedAt": new Date() } }
  );
}

async function enqueueResumeJob(run) {
  if (!run || !run.pendingResume || !run.pendingResume.resumeJobId) {
    throw new Error("Resume job id is missing");
  }
  await enqueueImpl(run);
  await stampEnqueued(run._id, run.pendingResume.resumeJobId);
}

async function completeExternalWait({
  runId,
  kind,
  nodeId,
  externalJobId,
  result,
  approval,
  playwrightByNode,
}) {
  const filter = {
    _id: runId,
    status: "waiting",
    "wait.state": "pending",
    "wait.kind": kind,
    "wait.nodeId": nodeId,
    "wait.externalJobId": externalJobId,
  };
  if (approval) filter["approval.decision"] = null;

  const branch =
    approval && (approval.branch === "true" || approval.branch === "false")
      ? approval.branch
      : result && (result.branch === "true" || result.branch === "false")
        ? result.branch
        : null;
  const completion = {
    branch,
    result: result === undefined ? null : result,
  };

  const setDoc = {
    wait: {
      $mergeObjects: [
        { $ifNull: ["$wait", {}] },
        { $literal: { state: "completing", completion } },
      ],
    },
  };

  if (approval) {
    setDoc.context = {
      $mergeObjects: [
        {
          $cond: [{ $eq: [{ $type: "$context" }, "object"] }, "$context", {}],
        },
        { $literal: { branch } },
      ],
    };
    setDoc.approval = {
      decision: approval.decision,
      userId: String(approval.userId),
      decidedAt: "$$NOW",
    };
    if (approval.planHash) setDoc.approval.planHash = String(approval.planHash);
    if (approval.fingerprint) setDoc.approval.fingerprint = String(approval.fingerprint);
    if (approval.expiresAt) setDoc.approval.expiresAt = String(approval.expiresAt);
    if (approval.baseSha) setDoc.approval.baseSha = String(approval.baseSha);
  }

  const stages = [
    { $set: setDoc },
    {
      $set: {
        pendingResume: {
          resumeJobId: "$wait.resumeJobId",
          payload: "$context",
          enqueuedAt: null,
        },
      },
    },
  ];
  if (playwrightByNode && playwrightByNode.nodeId && playwrightByNode.entry) {
    const entryNodeId = String(playwrightByNode.nodeId);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(entryNodeId)) {
      throw new Error("Node id must match ^[A-Za-z0-9_-]{1,64}$");
    }
    stages.push({
      $set: {
        "external.playwrightByNode": {
          $mergeObjects: [
            { $ifNull: ["$external.playwrightByNode", {}] },
            { $literal: { [entryNodeId]: playwrightByNode.entry } },
          ],
        },
      },
    });
  }

  return Run.findOneAndUpdate(filter, stages, pipelineUpdate);
}

function samePendingWait(run, args) {
  return Boolean(
    run &&
      run.wait &&
      run.wait.kind === args.kind &&
      run.wait.nodeId === args.nodeId &&
      run.wait.externalJobId === args.externalJobId
  );
}

function slackForPlaywrightSettle(args) {
  const result = args && args.result && typeof args.result === "object" ? args.result : {};
  if (args && args.kind !== "playwright") return null;
  if (result.branch === "true") return null;
  const failureClass = result.failureClass || (args.playwrightByNode && args.playwrightByNode.entry && args.playwrightByNode.entry.failureClass);
  const type = failureClass === "env" ? "env_failed" : "playwright_failed";
  return {
    type,
    reason: result.reason || failureClass || "playwright failed",
    stage: "playwright",
  };
}

/**
 * Atomic completion, then one resume enqueue.
 * A repeated call does not change `wait.completion`. When `enqueuedAt` is still
 * null, a non-decision caller may add the same resume id again.
 */
async function settleWait(args, options = {}) {
  const updated = await completeExternalWait(args);
  if (updated) {
    const slackEvent = slackForPlaywrightSettle(args);
    if (slackEvent) {
      const slack = require("./slackService");
      await slack.emit(updated._id, slackEvent.type, {
        reason: slackEvent.reason,
        stage: slackEvent.stage,
      });
    }
    try {
      await enqueueResumeJob(updated);
      const stamped = await Run.findById(updated._id);
      return { matched: true, enqueued: true, run: stamped };
    } catch (err) {
      return { matched: true, enqueued: false, error: err, run: updated };
    }
  }

  const current = await Run.findById(args.runId).lean();
  const recoverable =
    options.allowDuplicateEnqueue !== false &&
    samePendingWait(current, args) &&
    current.wait.state === "completing" &&
    current.pendingResume &&
    current.pendingResume.enqueuedAt == null;

  if (recoverable) {
    try {
      await enqueueResumeJob(current);
      return {
        matched: false,
        duplicate: true,
        enqueued: true,
        run: await Run.findById(args.runId),
      };
    } catch (err) {
      if (!jobAlreadyExists(err)) {
        return { matched: false, duplicate: true, enqueued: false, error: err, run: current };
      }
      await stampEnqueued(current._id, current.pendingResume.resumeJobId);
      return { matched: false, duplicate: true, enqueued: true, run: current };
    }
  }

  return { matched: false, enqueued: false, run: current };
}

async function enqueuePendingResumes() {
  const rows = await Run.find({
    "wait.state": "completing",
    "pendingResume.enqueuedAt": null,
  });
  for (const row of rows) {
    try {
      await enqueueResumeJob(row);
    } catch (err) {
      if (!jobAlreadyExists(err)) throw err;
      await stampEnqueued(row._id, row.pendingResume.resumeJobId);
    }
  }
}

async function enqueuePendingExternalJobs() {
  const rows = await Run.find({
    status: "waiting",
    "wait.state": "pending",
    "wait.kind": { $in: ["agent", "playwright"] },
    "wait.externalEnqueuedAt": null,
  });
  for (const row of rows) {
    const job = row.wait && row.wait.job;
    if (!job) continue;
    try {
      if (row.wait.kind === "agent") {
        const { enqueueAgent } = require("./cursorAgentService");
        await enqueueAgent(job);
      } else {
        const { enqueueSuite } = require("./playwrightService");
        await enqueueSuite(job);
      }
      await Run.updateOne(
        { _id: row._id, "wait.externalEnqueuedAt": null },
        { $set: { "wait.externalEnqueuedAt": new Date() } }
      );
    } catch (err) {
      if (!jobAlreadyExists(err)) {
        console.error("[wait] external enqueue failed:", err.message);
        continue;
      }
      await Run.updateOne(
        { _id: row._id, "wait.externalEnqueuedAt": null },
        { $set: { "wait.externalEnqueuedAt": new Date() } }
      );
    }
  }
}

module.exports = {
  completeExternalWait,
  settleWait,
  enqueuePendingResumes,
  enqueuePendingExternalJobs,
  setResumeEnqueue,
};
