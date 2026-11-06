const cron = require("node-cron");
const mongoose = require("mongoose");
const config = require("../../config");
const Workflow = require("../models/workflow");
const { enqueueWorkflowJob } = require("./enqueueWorkflowJob");

/** @type {Map<string, ReturnType<typeof cron.schedule>>} */
const scheduledByWorkflowId = new Map();

/** @type {ReturnType<typeof cron.schedule> | null} */
let dispatchTask = null;

function stopAllCronTasks() {
  for (const [, task] of [...scheduledByWorkflowId.entries()]) {
    task.stop();
  }
  scheduledByWorkflowId.clear();
}

function stopDispatcherCron() {
  if (!dispatchTask) return;
  dispatchTask.stop();
  dispatchTask = null;
}

function startDispatcherCron() {
  stopDispatcherCron();
  const expr = String(config.jiraDispatchCron || "").trim();
  if (!expr) return;
  if (!cron.validate(expr)) {
    console.warn(`[scheduler] Skipping Jira dispatcher: invalid cron "${expr}"`);
    return;
  }
  dispatchTask = cron.schedule(
    expr,
    async () => {
      try {
        const { dispatch } = require("./jiraDispatcher");
        await dispatch({ dryRun: false });
      } catch (err) {
        console.error("[scheduler] Jira dispatcher failed:", err.message);
      }
    },
    { scheduled: true }
  );
}

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
    startDispatcherCron();
  };

  if (mongoose.connection.readyState === 1) run();
  else mongoose.connection.once("connected", run);
}

module.exports = {
  startScheduler,
  syncCronSchedulesFromDb,
  startDispatcherCron,
  stopDispatcherCron,
};
