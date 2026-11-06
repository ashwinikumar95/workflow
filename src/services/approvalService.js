const Run = require("../models/Run");
const { settleWait } = require("./waitCompletion");

/**
 * One conditional update wins. Every other call returns 409 and does not enqueue.
 * If the winning update landed and the resume enqueue throws, the decision stays
 * and the caller gets 503.
 */
async function recordDecision(runId, decision, userId) {
  if (decision !== "approved" && decision !== "rejected") {
    return { http: 400, error: "decision must be approved or rejected" };
  }

  const run = await Run.findById(runId).lean();
  if (!run || !run.wait || run.wait.kind !== "approval") {
    return { http: 409, error: "Decision already recorded" };
  }

  const branch = decision === "approved" ? "true" : "false";
  const outcome = await settleWait(
    {
      runId: run._id,
      kind: "approval",
      nodeId: run.wait.nodeId,
      externalJobId: run.wait.externalJobId,
      result: { decision, branch },
      approval: {
        decision,
        userId: String(userId),
        branch,
      },
    },
    { allowDuplicateEnqueue: false }
  );

  if (!outcome.matched) {
    return { http: 409, error: "Decision already recorded" };
  }
  if (decision === "rejected") {
    const slack = require("./slackService");
    await slack.emit(run._id, "plan_rejected", {
      reason: "plan rejected",
      stage: "awaiting_approval",
      nodeId: run.wait && run.wait.nodeId,
    });
  }
  if (!outcome.enqueued) {
    return { http: 503, error: "Resume enqueue failed" };
  }
  return { http: 200, run: outcome.run };
}

module.exports = { recordDecision };
