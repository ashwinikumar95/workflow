let addImpl = null;

const suiteJobOptions = {
  attempts: 1,
  removeOnComplete: { count: 1000 },
  removeOnFail: false,
};

function setPlaywrightEnqueue(fn) {
  addImpl = typeof fn === "function" ? fn : null;
}

/**
 * Adds a playwright-queue job. This module does not run the suite.
 * @param {{ externalJobId: string }} data
 */
async function enqueueSuite(data) {
  if (!data || typeof data.externalJobId !== "string" || !/^[A-Za-z0-9_-]+$/.test(data.externalJobId)) {
    throw new Error("Playwright job id must match ^[A-Za-z0-9_-]+$");
  }
  const options = {
    jobId: data.externalJobId,
    ...suiteJobOptions,
  };
  if (addImpl) return addImpl("run-suite", data, options);
  const { getPlaywrightQueue } = require("./queue");
  return getPlaywrightQueue().add("run-suite", data, options);
}

module.exports = { enqueueSuite, setPlaywrightEnqueue };
