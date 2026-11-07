const { Worker, DelayedError } = require("bullmq");
const config = require("../../config");
const engine = require("../services/executionengine");

function buildWorkflowWorkerOptions(lockDurationMs) {
  if (!Number.isInteger(lockDurationMs) || lockDurationMs <= 0) {
    throw new Error(
      "lockRenewTime must be a positive integer strictly below lockDuration"
    );
  }
  const lockRenewTime = Math.floor(lockDurationMs / 2);
  if (!Number.isInteger(lockRenewTime) || lockRenewTime <= 0 || lockRenewTime >= lockDurationMs) {
    throw new Error(
      "lockRenewTime must be a positive integer strictly below lockDuration"
    );
  }
  return {
    connection: config.redisConnection,
    concurrency: 1,
    lockDuration: lockDurationMs,
    lockRenewTime,
  };
}

async function handleWorkflowJob(job, token) {
  if (job && job.name === "resume-workflow") {
    await engine.resumeWorkflow(job.data || {}, String(job.id));
    return;
  }
  if (job && job.name === "settle-wait") {
    const { settleWait } = require("../services/waitCompletion");
    const { prepareExternalSettle } = require("../services/externalSettle");
    const prepared = await prepareExternalSettle(job.data || {});
    await settleWait(prepared);
    return;
  }
  const workflowId = job.data && job.data.workflowId;
  const input = job.data && job.data.input;
  try {
    await engine.executeWorkflow(workflowId, input || {}, String(job.id));
  } catch (err) {
    if (err && err.code === "RUN_CLAIM_BUSY") {
      await job.moveToDelayed(Date.now() + config.executionClaimLeaseMs, token);
      throw new DelayedError();
    }
    throw err;
  }
}

function isFinalAttempt(job) {
  const max =
    job && job.opts && Number.isInteger(job.opts.attempts) && job.opts.attempts > 0
      ? job.opts.attempts
      : 1;
  const made = job && Number.isInteger(job.attemptsMade) ? job.attemptsMade : 0;
  return made >= max;
}

async function notifyWorkflowJobFailed(job, err) {
  if (!isFinalAttempt(job)) return;
  if (job && job.name === "settle-wait") {
    const data = job.data && typeof job.data === "object" ? job.data : {};
    const { failWaitingExternal } = require("../services/waitCompletion");
    await failWaitingExternal({
      runId: data.runId,
      kind: data.kind,
      nodeId: data.nodeId,
      externalJobId: data.externalJobId,
      error: err,
    });
  }
  const slack = require("../services/slackService");
  await slack.emitFromJob(job, err);
}

function startWorkflowWorker() {
  const connection = config.redisConnection;
  const worker = new Worker(
    "workflow-queue",
    async (job, token) => {
      console.log(
        "[Worker] Job picked up — jobId:",
        job.id,
        "workflowId:",
        job.data && job.data.workflowId
      );
      await handleWorkflowJob(job, token);
      console.log("[Worker] Job finished — jobId:", job.id);
    },
    buildWorkflowWorkerOptions(config.workerLockDurationMs)
  );

  worker.on("ready", () => {
    console.log(
      `[Worker] listening on Redis ${connection.host}:${connection.port} (queue: workflow-queue)`
    );
  });

  worker.on("completed", (job) => {
    console.log("[Worker] BullMQ completed event — jobId:", job.id);
  });

  worker.on("failed", (job, err) => {
    console.error(
      "[Worker] BullMQ failed event — jobId:",
      job?.id,
      "error:",
      err && err.message
    );
    notifyWorkflowJobFailed(job, err).catch((notifyErr) => {
      console.error("[Worker] Slack crash notify failed:", notifyErr.message);
    });
  });

  worker.on("error", (err) => {
    console.error("[Worker] Redis error:", err.message);
  });

  const pendingTimer = setInterval(() => {
    const { enqueuePendingResumes, enqueuePendingExternalJobs } = require("../services/waitCompletion");
    enqueuePendingResumes().catch((err) => {
      console.error("[Worker] enqueuePendingResumes failed:", err.message);
    });
    enqueuePendingExternalJobs().catch((err) => {
      console.error("[Worker] enqueuePendingExternalJobs failed:", err.message);
    });
    const retention = require("../services/retention");
    retention.runRetentionJobs().catch((err) => {
      console.error("[Worker] retention jobs failed:", err.message);
    });
    const recovery = require("../services/recovery");
    recovery.cleanupLeftoverProcesses().catch((err) => {
      console.error("[Worker] leftover process cleanup failed:", err.message);
    });
    const resourceLocks = require("../services/resourceLocks");
    resourceLocks.heartbeat().catch((err) => {
      console.error("[Worker] resource lock heartbeat failed:", err.message);
    });
    const slack = require("../services/slackService");
    slack.retryPending().catch((err) => {
      console.error("[Worker] Slack retry failed:", err.message);
    });
  }, 5000);
  if (typeof pendingTimer.unref === "function") pendingTimer.unref();
  worker.on("closed", () => clearInterval(pendingTimer));

  const recovery = require("../services/recovery");
  recovery.cleanupLeftoverProcesses().catch((err) => {
    console.error("[Worker] leftover process cleanup on start failed:", err.message);
  });

  return worker;
}

if (process.env.WORKFLOW_WORKER_AUTOSTART !== "false") {
  startWorkflowWorker();
}

module.exports = {
  buildWorkflowWorkerOptions,
  handleWorkflowJob,
  isFinalAttempt,
  notifyWorkflowJobFailed,
  startWorkflowWorker,
};
