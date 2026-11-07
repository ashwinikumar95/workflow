const { Queue } = require("bullmq");
const config = require("../../config");

const connection = config.redisConnection;

const queue = new Queue("workflow-queue", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: false,
  },
});

queue.on("error", (err) => {
  console.error("[Queue] Redis connection error:", err.message);
});

console.log(
  `[Queue] workflow-queue → Redis ${connection.host}:${connection.port}`
);

const retention = {
  removeOnComplete: { count: 1000 },
  removeOnFail: false,
};

let agentQueue;
let playwrightQueue;

function getAgentQueue() {
  if (!agentQueue) {
    agentQueue = new Queue("agent-queue", {
      connection,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 2000 },
        ...retention,
      },
    });
    agentQueue.on("error", (err) => {
      console.error("[Queue] agent-queue Redis error:", err.message);
    });
  }
  return agentQueue;
}

function getPlaywrightQueue() {
  if (!playwrightQueue) {
    playwrightQueue = new Queue("playwright-queue", {
      connection,
      defaultJobOptions: {
        attempts: 1,
        ...retention,
      },
    });
    playwrightQueue.on("error", (err) => {
      console.error("[Queue] playwright-queue Redis error:", err.message);
    });
  }
  return playwrightQueue;
}

module.exports = queue;
module.exports.workflowQueue = queue;
module.exports.getAgentQueue = getAgentQueue;
module.exports.getPlaywrightQueue = getPlaywrightQueue;
module.exports.retention = retention;
