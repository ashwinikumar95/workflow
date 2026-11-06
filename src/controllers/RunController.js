const mongoose = require("mongoose");
const Run = require("../models/Run");
const Workflow = require("../models/workflow");
const { redactRunForResponse } = require("../utils/redactSecrets");
const { recordDecision } = require("../services/approvalService");
const runControl = require("../services/runControl");

function invalidIdResponse(res) {
  return res.status(400).json({ error: "Invalid id" });
}

function notFoundResponse(res) {
  return res.status(404).json({ error: "Not found" });
}

exports.listRunsForWorkflow = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return invalidIdResponse(res);

    const wf = await Workflow.findOne({ _id: id, userId: req.user.id })
      .select("_id")
      .lean();
    if (!wf) {
      return notFoundResponse(res);
    }

    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit), 10) || 20));
    const skip = (page - 1) * limit;

    const [runs, total] = await Promise.all([
      Run.find({ workflowId: id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Run.countDocuments({ workflowId: id }),
    ]);

    res.json({
      runs: runs.map((run) => redactRunForResponse(run)),
      page,
      limit,
      total,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getRunById = async (req, res) => {
  try {
    const { runId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(runId)) return invalidIdResponse(res);

    const run = await Run.findById(runId).lean();
    if (!run) {
      return notFoundResponse(res);
    }

    const wf = await Workflow.findOne({
      _id: run.workflowId,
      userId: req.user.id,
    })
      .select("_id")
      .lean();
    if (!wf) {
      return notFoundResponse(res);
    }

    res.json(redactRunForResponse(run));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.decideRun = async (req, res) => {
  try {
    const { runId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(runId)) return invalidIdResponse(res);

    const run = await Run.findById(runId).lean();
    if (!run) return notFoundResponse(res);

    const wf = await Workflow.findById(run.workflowId).select("userId").lean();
    if (!wf) return notFoundResponse(res);
    if (String(wf.userId) !== String(req.user.id)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const outcome = await recordDecision(run._id, req.body && req.body.decision, req.user.id);
    if (outcome.http === 200) {
      return res.status(200).json(redactRunForResponse(outcome.run));
    }
    return res.status(outcome.http).json({ error: outcome.error });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

async function ownedRun(req, res) {
  const { runId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(runId)) {
    invalidIdResponse(res);
    return null;
  }
  const run = await Run.findById(runId).lean();
  if (!run) {
    notFoundResponse(res);
    return null;
  }
  const wf = await Workflow.findById(run.workflowId).select("userId").lean();
  if (!wf) {
    notFoundResponse(res);
    return null;
  }
  if (String(wf.userId) !== String(req.user.id)) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return run;
}

exports.cancelRun = async (req, res) => {
  try {
    const run = await ownedRun(req, res);
    if (!run) return;
    const outcome = await runControl.cancelRun(run._id);
    if (outcome.http === 200) {
      return res.status(200).json(redactRunForResponse(outcome.run));
    }
    return res.status(outcome.http).json({ error: outcome.error });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.retryRun = async (req, res) => {
  try {
    const run = await ownedRun(req, res);
    if (!run) return;
    const outcome = await runControl.retryRun(run._id);
    if (outcome.http === 200) {
      return res.status(200).json(redactRunForResponse(outcome.run));
    }
    return res.status(outcome.http).json({ error: outcome.error });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
