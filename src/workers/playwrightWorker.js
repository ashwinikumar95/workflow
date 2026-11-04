const { Worker } = require("bullmq");
const config = require("../../config");
const queue = require("../services/queue");
const { handlePlaywrightJob } = require("../services/playwrightAttempt");
const { getPlaywrightQueue } = require("../services/queue");
const { assertPinnedImage } = require("../services/containerSpec");

async function enqueueSettle(payload) {
  await queue.add("settle-wait", payload, {
    jobId: `settle-playwright-${payload.runId}-${payload.nodeId}`,
    attempts: 3,
    removeOnComplete: { count: 1000 },
    removeOnFail: false,
  });
}

function bootstrap(job, reason) {
  return enqueueSettle({
    runId: job.data && job.data.runId,
    workflowId: job.data && job.data.workflowId,
    nodeId: job.data && job.data.nodeId,
    kind: "playwright",
    externalJobId: job.data && job.data.externalJobId,
    worktreePath: job.data && (job.data.appWorktree || job.data.worktreePath),
    testedSha: job.data && job.data.testedSha,
    result: {
      branch: "false",
      status: "bootstrap-failed",
      failureClass: "bootstrap",
      reportPresent: false,
      reason,
    },
  });
}

function startPlaywrightWorker() {
  const worker = new Worker(
    "playwright-queue",
    async (job) => {
      const image = (job.data && job.data.image) || config.playwrightImage;
      if (!image) {
        await bootstrap(job, "image-unpinned");
        return;
      }
      try {
        assertPinnedImage(image);
      } catch {
        await bootstrap(job, "image-unpinned");
        return;
      }
      const data = { ...(job.data || {}), image };
      await handlePlaywrightJob({ ...job, data }, { enqueueSettle });
    },
    { connection: config.redisConnection, concurrency: 1 }
  );
  worker.on("error", (err) => {
    console.error("[playwright-worker]", err.message);
  });
  return worker;
}

if (process.env.PLAYWRIGHT_WORKER_AUTOSTART !== "false") {
  getPlaywrightQueue();
  startPlaywrightWorker();
}

module.exports = { startPlaywrightWorker, enqueueSettle };
