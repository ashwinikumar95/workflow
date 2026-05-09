const { Worker } = require("bullmq");
const config = require("../../config");
const { executeWorkflow } = require("../services/executionEngine");

const connection = config.redisConnection;

const worker = new Worker(
  "workflow-queue",
  async (job) => {
    const { workflowId, input } = job.data;
    console.log(
      "[Worker] Job picked up — jobId:",
      job.id,
      "workflowId:",
      workflowId
    );
    await executeWorkflow(workflowId, input || {}, String(job.id));
    console.log("[Worker] Job finished — jobId:", job.id);
  },
  { connection }
);

worker.on("ready", () => {
  console.log(
    `[Worker] listening on Redis ${connection.host}:${connection.port} (queue: workflow-queue)`
  );
});

worker.on("completed", (job) => {
  console.log("[Worker] BullMQ completed event — jobId:", job.id);
});

worker.on("failed", (job, err) => {
  console.error(
    "[Worker] BullMQ failed event — jobId:",
    job?.id,
    "error:",
    err.message
  );
});

worker.on("error", (err) => {
  console.error("[Worker] Redis error:", err.message);
});

module.exports = worker;
