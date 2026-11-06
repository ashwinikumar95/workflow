const Run = require("../models/Run");
const Workflow = require("../models/workflow");
const TicketRun = require("../models/TicketRun");
const resourceLocks = require("./resourceLocks");
const ticketState = require("./ticketState");
const recovery = require("./recovery");

function cancelledError() {
  const err = new Error("RUN_CANCELLED");
  err.code = "RUN_CANCELLED";
  return err;
}

async function defaultEnqueue(run) {
  const { enqueueWorkflowJob } = require("./enqueueWorkflowJob");
  const queue = require("./queue");
  try {
    const existing = await queue.getJob(run.jobId);
    if (existing) await existing.remove();
  } catch {
    // Redis may be down in unit tests; enqueue still records the intent.
  }
  const input = run.context && typeof run.context === "object" && !Array.isArray(run.context) ? run.context : {};
  await enqueueWorkflowJob(run.workflowId, input, { jobId: run.jobId });
}

async function removeJobs(run) {
  const queue = require("./queue");
  const { getAgentQueue, getPlaywrightQueue } = require("./queue");
  const ids = [run.jobId];
  if (run.wait && run.wait.externalJobId) ids.push(run.wait.externalJobId);
  if (run.wait && run.wait.resumeJobId) ids.push(run.wait.resumeJobId);
  const queues = [queue];
  try {
    queues.push(getAgentQueue(), getPlaywrightQueue());
  } catch {
    // queues optional
  }
  for (const q of queues) {
    for (const id of ids) {
      if (!id) continue;
      try {
        const job = await q.getJob(id);
        if (job) await job.remove();
      } catch {
        // ignore missing jobs
      }
    }
  }
}

async function cancelRun(runId, deps = {}) {
  const run = await Run.findById(runId);
  if (!run) return { http: 404, error: "Not found" };
  if (run.status === "success" || run.status === "cancelled") {
    return { http: 409, error: "Run cannot be cancelled" };
  }

  const ticket = await TicketRun.findOne({ runId: String(run._id) });
  if (ticket) {
    if (ticketState.isTerminal(ticket.state) && ticket.state !== "cancelled") {
      return { http: 409, error: "Run cannot be cancelled" };
    }
    if (ticket.state !== "cancelled") {
      const moved = await ticketState.transition(ticket._id, ticket.state, "cancelled", {
        failureReason: "cancelled",
      });
      if (!moved.ok && ticket.state !== "cancelled") {
        return { http: 409, error: "Run cannot be cancelled" };
      }
    }
  }

  await recovery.killRunProcesses(run, ticket, deps);
  await resourceLocks.releaseByOwner(String(run._id));
  if (deps.removeJobs) await deps.removeJobs(run);
  else await removeJobs(run).catch(() => {});

  const updated = await Run.findOneAndUpdate(
    { _id: run._id, status: { $nin: ["success"] } },
    {
      $set: {
        status: "cancelled",
        endedAt: new Date(),
      },
    },
    { returnDocument: "after" }
  );

  return { http: 200, run: updated || run };
}

async function retryRun(runId, deps = {}) {
  const run = await Run.findById(runId);
  if (!run) return { http: 404, error: "Not found" };

  const ticket = await TicketRun.findOne({ runId: String(run._id) });
  const retryableRun = run.status === "failed" || run.status === "interrupted";
  const retryableTicket = Boolean(
    ticket && (ticket.state === "interrupted" || ticket.state === "failed" || ticket.state === "blocked")
  );
  if (!retryableRun && !retryableTicket) {
    return { http: 409, error: "Run cannot be retried" };
  }

  let recoveryResult = { ok: true, action: "resume", currentNodeId: run.currentNodeId };
  if (ticket) {
    recoveryResult = await recovery.recoverTicket(ticket, { ...deps, run, manual: true });
  }

  const currentNodeId = recoveryResult.currentNodeId || run.currentNodeId;
  await Run.updateOne(
    { _id: run._id },
    {
      $set: {
        status: "running",
        currentNodeId,
        endedAt: null,
        executionClaim: null,
        executionClaimExpiresAt: null,
      },
    }
  );

  const freshTicket = ticket ? await TicketRun.findById(ticket._id) : null;
  if (freshTicket && freshTicket.state === "interrupted") {
    const dest = recoveryResult.resumeState || "implementing";
    if (ticketState.isAllowed("interrupted", dest)) {
      await ticketState.transition(freshTicket._id, "interrupted", dest);
    }
  }

  const latest = await Run.findById(run._id);
  const enqueue = deps.enqueue || defaultEnqueue;
  await enqueue(latest);

  return { http: 200, run: latest, recovery: recoveryResult };
}

module.exports = {
  cancelledError,
  cancelRun,
  retryRun,
  removeJobs,
};
