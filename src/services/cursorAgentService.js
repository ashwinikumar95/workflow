let addImpl = null;

const agentJobOptions = {
  attempts: 2,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: false,
};

function setAgentEnqueue(fn) {
  addImpl = typeof fn === "function" ? fn : null;
}

/**
 * Adds an agent-queue job. This module does not import `@cursor/sdk`.
 * @param {{ externalJobId: string }} data
 */
async function enqueueAgent(data) {
  if (!data || typeof data.externalJobId !== "string" || !/^[A-Za-z0-9_-]+$/.test(data.externalJobId)) {
    throw new Error("Agent job id must match ^[A-Za-z0-9_-]+$");
  }
  const options = {
    jobId: data.externalJobId,
    ...agentJobOptions,
  };
  if (addImpl) return addImpl("run-agent", data, options);
  const { getAgentQueue } = require("./queue");
  return getAgentQueue().add("run-agent", data, options);
}

module.exports = { enqueueAgent, setAgentEnqueue };
