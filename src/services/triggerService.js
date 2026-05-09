const Workflow = require("../models/Workflow");
const { enqueueWorkflowJob } = require("./enqueueWorkflowJob");

async function triggerWebhook(workflowId, req) {
  const workflow = await Workflow.findById(workflowId);

  if (!workflow) {
    const err = new Error("Workflow not found");
    err.statusCode = 404;
    throw err;
  }

  if (workflow.trigger?.type !== "webhook") {
    const err = new Error("Workflow is not webhook-triggered");
    err.statusCode = 400;
    throw err;
  }

  if (workflow.status !== "published") {
    const err = new Error("Workflow not published");
    err.statusCode = 400;
    throw err;
  }

  if (workflow.trigger?.enabled === false) {
    const err = new Error("Workflow is paused");
    err.statusCode = 403;
    throw err;
  }

  const secret = workflow.trigger?.config?.secret;

  if (secret) {
    const incomingSecret = req.headers["x-webhook-secret"];

    if (incomingSecret !== secret) {
      const err = new Error("Invalid webhook secret");
      err.statusCode = 401;
      throw err;
    }
  }

  const job = await enqueueWorkflowJob(workflowId, req.body || {});

  return { jobId: job.id };
}

module.exports = { triggerWebhook };
