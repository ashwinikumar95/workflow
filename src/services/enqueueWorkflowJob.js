const queue = require("./queue");

const JOB_NAME = "execute-workflow";

/**
 * @param {import("mongoose").Types.ObjectId | string} workflowId
 * @param {Record<string, unknown>} [input]
 * @param {import("bullmq").JobsOptions} [extraOptions]
 */
async function enqueueWorkflowJob(workflowId, input = {}, extraOptions = {}) {
  const wid =
    workflowId != null && typeof workflowId === "object" && "toString" in workflowId
      ? workflowId.toString()
      : String(workflowId);

  return queue.add(
    JOB_NAME,
    { workflowId: wid, input: input && typeof input === "object" ? input : {} },
    extraOptions
  );
}

module.exports = { enqueueWorkflowJob, JOB_NAME };
