const cron = require("node-cron");
const mongoose = require("mongoose");
const Workflow = require("../models/Workflow");
const { enqueueWorkflowJob } = require("./enqueueWorkflowJob");

/** @type {Map<string, ReturnType<typeof cron.schedule>>} */
const scheduledByWorkflowId = new Map();

function stopAllCronTasks() {
  for (const [, task] of [...scheduledByWorkflowId.entries()]) {
    task.stop();
  }
  scheduledByWorkflowId.clear();
}

/**
 * Rebuilds cron jobs from the database: only published workflows with
 * trigger.type === "cron", trigger.enabled !== false, and a valid cron expression.
 */
async function syncCronSchedulesFromDb() {
  stopAllCronTasks();

  const workflows = await Workflow.find({
    status: "published",
    "trigger.type": "cron",
    "trigger.enabled": { $ne: false },
  }).lean();

  for (const wf of workflows) {
    const cronExp = wf.trigger?.config?.cron;
    if (typeof cronExp !== "string") continue;

    const trimmed = cronExp.trim();
    if (!trimmed) continue;

    if (!cron.validate(trimmed)) {
      console.warn(
        `[scheduler] Skipping workflow ${wf._id}: invalid cron "${trimmed}"`
      );
      continue;
    }

    const id = wf._id.toString();
    const workflowObjectId = wf._id;

    const task = cron.schedule(
      trimmed,
      async () => {
        try {
          await enqueueWorkflowJob(workflowObjectId, {});
        } catch (err) {
          console.error(`[scheduler] Cron run failed (${id}):`, err.message);
        }
      },
      { scheduled: true }
    );

    scheduledByWorkflowId.set(id, task);
  }

  console.log(
    `[scheduler] Active cron workflows: ${scheduledByWorkflowId.size}`
  );
}

function startScheduler() {
  const run = () => {
    syncCronSchedulesFromDb().catch((err) =>
      console.error("[scheduler] Sync failed:", err.message)
    );
  };

  if (mongoose.connection.readyState === 1) run();
  else mongoose.connection.once("connected", run);
}

module.exports = { startScheduler, syncCronSchedulesFromDb };
