const Run = require("../models/Run");
const { settleWait } = require("./waitCompletion");

function expiryHoursFromContext(context) {
  const key = context && typeof context.profileKey === "string" ? context.profileKey : "";
  if (!key) return 24;
  try {
    const { parseProfiles } = require("./projectRegistry");
    const profile = parseProfiles()[key];
    if (profile && Number.isInteger(profile.approvalExpiryHours) && profile.approvalExpiryHours > 0) {
      return profile.approvalExpiryHours;
    }
  } catch {
    // Profiles are optional for ad-hoc workflows.
  }
  return 24;
}

function fingerprintFrom(run) {
  const ctx = run && run.context && typeof run.context === "object" ? run.context : {};
  if (typeof ctx.fingerprint === "string" && ctx.fingerprint) return ctx.fingerprint;
  if (ctx.jira && typeof ctx.jira.fingerprint === "string") return ctx.jira.fingerprint;
  return "";
}

function evaluateApproval({
  decision,
  approvedPlanHash,
  currentPlanHash,
  approvedFingerprint,
  currentFingerprint,
  expiresAt,
  now,
} = {}) {
  if (decision && decision !== "approved") {
    return { ok: false, replan: false, reason: "not_approved" };
  }
  if (approvedPlanHash || currentPlanHash) {
    if (!approvedPlanHash || !currentPlanHash || approvedPlanHash !== currentPlanHash) {
      return { ok: false, replan: true, reason: "plan_hash_mismatch" };
    }
  }
  if (approvedFingerprint && currentFingerprint && approvedFingerprint !== currentFingerprint) {
    return { ok: false, replan: true, reason: "fingerprint_changed" };
  }
  if (expiresAt) {
    const expiry = new Date(expiresAt).getTime();
    const current = (now ? new Date(now) : new Date()).getTime();
    if (Number.isFinite(expiry) && expiry <= current) {
      return { ok: false, replan: true, reason: "expired" };
    }
  }
  return { ok: true };
}

/**
 * One conditional update wins. Every other call returns 409 and does not enqueue.
 * If the winning update landed and the resume enqueue throws, the decision stays
 * and the caller gets 503.
 */
async function recordDecision(runId, decision, userId, extras = {}) {
  if (decision !== "approved" && decision !== "rejected") {
    return { http: 400, error: "decision must be approved or rejected" };
  }

  const run = await Run.findById(runId).lean();
  if (!run || !run.wait || run.wait.kind !== "approval") {
    return { http: 409, error: "Decision already recorded" };
  }

  const expectedHash = run.context && typeof run.context.planHash === "string" ? run.context.planHash : "";
  if (expectedHash) {
    const given = extras && typeof extras.planHash === "string" ? extras.planHash : "";
    if (!given || given !== expectedHash) {
      return { http: 409, error: "Stale plan hash" };
    }
  }

  const hours = expiryHoursFromContext(run.context);
  const expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  const fingerprint = fingerprintFrom(run);
  const planHash = expectedHash || (extras && extras.planHash) || "";
  const baseSha = run.context && typeof run.context.baseSha === "string" ? run.context.baseSha : "";

  const questions =
    run.wait.nodeId === "approvePlan" &&
    run.context &&
    run.context.plan &&
    Array.isArray(run.context.plan.questions)
      ? run.context.plan.questions.filter((question) => typeof question === "string" && question.trim())
      : [];
  let clarifications;
  if (decision === "approved" && questions.length) {
    const answers = extras && Array.isArray(extras.answers) ? extras.answers : [];
    const complete =
      answers.length === questions.length &&
      answers.every((answer) => typeof answer === "string" && answer.trim());
    if (!complete) {
      return { http: 400, error: "Answer every plan question before approving" };
    }
    clarifications = questions.map((question, index) => ({
      question,
      answer: answers[index].trim(),
    }));
  }

  const branch = decision === "approved" ? "true" : "false";
  const approval = {
    decision,
    userId: String(userId),
    branch,
  };
  if (clarifications) approval.clarifications = clarifications;
  if (planHash) approval.planHash = planHash;
  if (fingerprint) approval.fingerprint = fingerprint;
  if (planHash) approval.expiresAt = expiresAt;
  if (baseSha) approval.baseSha = baseSha;

  const outcome = await settleWait(
    {
      runId: run._id,
      kind: "approval",
      nodeId: run.wait.nodeId,
      externalJobId: run.wait.externalJobId,
      result: { decision, branch },
      approval,
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

module.exports = { recordDecision, evaluateApproval, expiryHoursFromContext };
