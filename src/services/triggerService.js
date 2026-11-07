const crypto = require("crypto");
const Workflow = require("../models/workflow");
const { enqueueWorkflowJob } = require("./enqueueWorkflowJob");
const { fetchIssue, ISSUE_KEY } = require("./jiraService");

const EVENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

function httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function secretsMatch(headerValue, expected) {
  const left = crypto.createHash("sha256").update(String(headerValue ?? ""), "utf8").digest();
  const right = crypto.createHash("sha256").update(String(expected), "utf8").digest();
  return crypto.timingSafeEqual(left, right);
}

/**
 * Validate a Jira Automation delivery and return the canonical job id.
 * Does not enqueue. A bad key does not call Jira.
 */
async function prepareJiraDelivery(body, headers, deps = {}) {
  const secret = process.env.JIRA_WEBHOOK_SECRET;
  if (!secret || !secretsMatch(headers && headers["x-webhook-secret"], secret)) {
    throw httpError("Invalid webhook secret", 401);
  }

  const payload = body && typeof body === "object" ? body : {};
  if (typeof payload.eventId !== "string" || !EVENT_ID.test(payload.eventId)) {
    throw httpError("eventId is required", 400);
  }
  if (typeof payload.issueKey !== "string" || !ISSUE_KEY.test(payload.issueKey)) {
    throw httpError("Invalid issue key", 400);
  }

  const issue = await fetchIssue(payload.issueKey, deps);
  if (!issue.id || !/^[A-Za-z0-9_-]+$/.test(issue.id)) {
    throw httpError("Jira did not return a usable issue id", 400);
  }
  if (payload.issueId != null && String(payload.issueId) !== String(issue.id)) {
    throw httpError("issueId does not match Jira", 400);
  }

  return {
    jobId: `jira_${issue.id}_${payload.eventId}`,
    input: {
      issueKey: issue.key,
      issueId: issue.id,
      eventId: payload.eventId,
      jira: issue,
    },
  };
}

async function triggerWebhook(workflowId, req, deps = {}) {
  const workflow = await Workflow.findById(workflowId);

  if (!workflow) throw httpError("Workflow not found", 404);

  if (workflow.trigger?.type !== "webhook") {
    throw httpError("Workflow is not webhook-triggered", 400);
  }

  if (workflow.status !== "published") {
    throw httpError("Workflow not published", 400);
  }

  if (workflow.trigger?.enabled === false) {
    throw httpError("Workflow is paused", 403);
  }

  const enqueue = deps.enqueue || enqueueWorkflowJob;

  if (workflow.trigger?.config?.provider === "jira") {
    const prepared = await prepareJiraDelivery(req.body || {}, req.headers || {}, deps);
    try {
      const job = await enqueue(workflowId, prepared.input, { jobId: prepared.jobId });
      return { jobId: job && job.id ? job.id : prepared.jobId };
    } catch (err) {
      if (err && /already exists/i.test(err.message || "")) {
        return { jobId: prepared.jobId };
      }
      throw err;
    }
  }

  const secret = workflow.trigger?.config?.secret;

  if (secret) {
    const incomingSecret = req.headers["x-webhook-secret"];

    if (incomingSecret !== secret) {
      throw httpError("Invalid webhook secret", 401);
    }
  }

  const job = await enqueue(workflowId, req.body || {});

  return { jobId: job.id };
}

module.exports = { triggerWebhook, prepareJiraDelivery, secretsMatch };
