const JOB_NAME = "execute-workflow";
const RESUME_JOB_NAME = "resume-workflow";
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function workflowQueue() {
  return require("./queue");
}

/**
 * @param {import("mongoose").Types.ObjectId | string} workflowId
 * @param {Record<string, unknown>} [input]
 * @param {import("bullmq").JobsOptions & { runId?: string, startNodeId?: string, jobName?: string }} [extraOptions]
 */
async function enqueueWorkflowJob(workflowId, input = {}, extraOptions = {}) {
  const wid =
    workflowId != null && typeof workflowId === "object" && "toString" in workflowId
      ? workflowId.toString()
      : String(workflowId);

  const options = extraOptions && typeof extraOptions === "object" ? { ...extraOptions } : {};
  const runId = options.runId;
  const startNodeId = options.startNodeId;
  const jobName = options.jobName || JOB_NAME;
  delete options.runId;
  delete options.startNodeId;
  delete options.jobName;

  if (options.jobId != null) {
    const jobId = String(options.jobId);
    if (!JOB_ID_PATTERN.test(jobId)) {
      throw new Error("Job id must match ^[A-Za-z0-9_-]+$");
    }
    options.jobId = jobId;
  }

  const data = {
    workflowId: wid,
    input: input && typeof input === "object" ? input : {},
  };
  if (runId != null) data.runId = String(runId);
  if (startNodeId != null) data.startNodeId = String(startNodeId);

  return workflowQueue().add(jobName, data, options);
}

module.exports = { enqueueWorkflowJob, JOB_NAME, RESUME_JOB_NAME, JOB_ID_PATTERN };
