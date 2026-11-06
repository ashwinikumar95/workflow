import { createRequire } from "module";
import { spawn } from "child_process";
import { Worker } from "bullmq";

const require = createRequire(import.meta.url);
const config = require("../../config");
const { handleAgentJob } = require("../services/agentAttempt");
const { getAgentQueue } = require("../services/queue");
const { startAgentHost } = require("../services/hostRunners");

const connection = config.redisConnection;

async function enqueueSettle(payload) {
  const queue = require("../services/queue");
  const jobId = `settle-agent-${payload.runId}-${payload.nodeId}`;
  await queue.add("settle-wait", payload, {
    jobId,
    attempts: 3,
    removeOnComplete: { count: 1000 },
    removeOnFail: false,
  });
}

function startContainer(spec) {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.runtime || "docker", spec.args, {
      shell: false,
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      spawn(spec.runtime || "docker", ["kill", spec.name], {
        shell: false,
        windowsHide: true,
      });
    }, config.agentTimeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    child.on("error", (err) => {
      clearTimeout(timer);
      err.runtimeMissing = true;
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ status: "finished" });
      else reject(Object.assign(new Error(`container exited ${code}`), { code }));
    });
  });
}

function startAgentWorker() {
  const worker = new Worker(
    "agent-queue",
    async (job) => {
      const runtime = job.data && job.data.runtime;
      await handleAgentJob(job, {
        enqueueSettle,
        egressHosts: config.cursorEgressHosts,
        startContainer: runtime === "host" ? startAgentHost : startContainer,
      });
    },
    { connection, concurrency: 1 }
  );
  worker.on("error", (err) => {
    console.error("[agent-worker]", err.message);
  });
  return worker;
}

if (process.env.AGENT_WORKER_AUTOSTART !== "false") {
  getAgentQueue();
  if (!config.cursorEgressHosts.length) {
    console.error("[agent-worker] CURSOR_EGRESS_HOSTS is empty; agent jobs fail closed");
  }
  startAgentWorker();
}

export { startAgentWorker, enqueueSettle };
