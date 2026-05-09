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

module.exports = queue;
