const mongoose = require("mongoose");
const Run = require("../models/Run");
const Workflow = require("../models/Workflow");

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

    res.json({ runs, page, limit, total });
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

    res.json(run);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
