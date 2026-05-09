const mongoose = require("mongoose");
const Workflow = require("../models/Workflow");
const { syncCronSchedulesFromDb } = require("../services/schedulerService");
const { enqueueWorkflowJob } = require("../services/enqueueWorkflowJob");
const { validateWorkflowGraph } = require("../utils/workflowGraph");

function resyncCronSchedules() {
  syncCronSchedulesFromDb().catch((err) =>
    console.error("[scheduler] Resync after workflow change failed:", err.message)
  );
}

function invalidIdResponse(res) {
  return res.status(400).json({ error: "Invalid workflow id" });
}

function notFoundResponse(res) {
  return res.status(404).json({ error: "Workflow not found" });
}

/**
 * @param {Record<string, unknown>} body
 * @returns {Record<string, unknown>}
 */
function stripUserIdField(body) {
  const out = { ...body };
  delete out.userId;
  return out;
}

exports.createWorkflow = async (req, res) => {
  try {
    const data = stripUserIdField(req.body);
    const workflow = await Workflow.create({ ...data, userId: req.user.id });
    resyncCronSchedules();
    res.status(201).json(workflow);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.listWorkflows = async (req, res) => {
  try {
    const workflows = await Workflow.find({ userId: req.user.id })
      .sort({ updatedAt: -1 })
      .lean();
    res.json(workflows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getWorkflowById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return invalidIdResponse(res);

    const workflow = await Workflow.findOne({
      _id: id,
      userId: req.user.id
    }).lean();
    if (!workflow) {
      return notFoundResponse(res);
    }
    res.json(workflow);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.setTriggerEnabled = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return invalidIdResponse(res);

    const enabled = req.body?.enabled;
    if (typeof enabled !== "boolean") {
      return res
        .status(400)
        .json({ error: "Request body must include enabled as a boolean" });
    }

    const workflow = await Workflow.findOneAndUpdate(
      {
        _id: id,
        userId: req.user.id,
        "trigger.type": { $in: ["webhook", "cron"] }
      },
      { $set: { "trigger.enabled": enabled } },
      { new: true, runValidators: true }
    ).lean();

    if (!workflow) {
      const exists = await Workflow.findOne({ _id: id, userId: req.user.id })
        .select("trigger")
        .lean();
      if (!exists) return notFoundResponse(res);
      return res.status(400).json({
        error:
          "Save webhook or cron trigger settings on this workflow before using pause/resume."
      });
    }

    resyncCronSchedules();
    res.json(workflow);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateWorkflow = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return invalidIdResponse(res);

    const existing = await Workflow.findOne({ _id: id, userId: req.user.id });
    if (!existing) {
      return notFoundResponse(res);
    }

    const updates = stripUserIdField(req.body);

    if (existing.status === "published") {
      const keys = Object.keys(updates);
      const disallowed = keys.filter((k) => k !== "name");
      if (disallowed.length > 0) {
        return res.status(403).json({
          error:
            "Published workflow is frozen. You may only rename it; use Publish flow for new versions or pause/resume for triggers.",
        });
      }
      if (updates.name === undefined) {
        return res.status(400).json({ error: "No allowed fields to update" });
      }
      existing.name = updates.name;
      await existing.save();
      resyncCronSchedules();
      return res.json(existing.toObject());
    }

    const workflow = await Workflow.findOneAndUpdate(
      { _id: id, userId: req.user.id },
      updates,
      { returnDocument: "after", runValidators: true }
    ).lean();

    if (!workflow) {
      return notFoundResponse(res);
    }
    resyncCronSchedules();
    res.json(workflow);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.replaceWorkflow = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return invalidIdResponse(res);

    const doc = await Workflow.findOne({ _id: id, userId: req.user.id });
    if (!doc) {
      return notFoundResponse(res);
    }

    if (doc.status === "published") {
      return res.status(403).json({
        error: "Cannot replace a published workflow (graph is frozen).",
      });
    }

    const replacement = stripUserIdField(req.body);
    delete replacement._id;

    doc.overwrite({ ...replacement, userId: req.user.id });
    await doc.save();
    resyncCronSchedules();
    res.json(doc.toObject());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.publishWorkflow = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return invalidIdResponse(res);

    const doc = await Workflow.findOne({ _id: id, userId: req.user.id });
    if (!doc) {
      return notFoundResponse(res);
    }

    if (doc.status === "published") {
      return res.status(400).json({ error: "Workflow is already published" });
    }

    const check = validateWorkflowGraph(doc.toObject());
    if (!check.ok) {
      return res.status(400).json({ error: check.message });
    }

    const trig = doc.trigger;
    if (trig?.type === "cron") {
      const c = trig?.config?.cron;
      if (typeof c !== "string" || !c.trim()) {
        return res.status(400).json({
          error: "Cron trigger requires a non-empty config.cron expression",
        });
      }
    }

    doc.status = "published";
    await doc.save();
    resyncCronSchedules();
    res.json(doc.toObject());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.startWorkflow = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return invalidIdResponse(res);

    const workflow = await Workflow.findOne({ _id: id, userId: req.user.id });
    if (!workflow) {
      return notFoundResponse(res);
    }

    if (workflow.status !== "published") {
      return res.status(400).json({ error: "Workflow must be published to start" });
    }

    if (workflow.trigger?.enabled === false) {
      return res.status(403).json({ error: "Workflow is paused" });
    }

    const input =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? req.body
        : {};

    const job = await enqueueWorkflowJob(workflow._id, input);
    res.status(202).json({ message: "Workflow queued", jobId: job.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deleteWorkflow = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return invalidIdResponse(res);

    const workflow = await Workflow.findOneAndDelete({
      _id: id,
      userId: req.user.id
    }).lean();
    if (!workflow) {
      return notFoundResponse(res);
    }
    resyncCronSchedules();
    res.json({ message: "Workflow deleted", id: workflow._id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
