const { triggerWebhook } = require("../services/triggerService");

exports.handleWebhook = async (req, res) => {
  try {
    const { jobId } = await triggerWebhook(req.params.id, {
      body: req.body,
      headers: req.headers
    });

    res.status(202).json({
      message: "Workflow queued",
      jobId
    });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message });
  }
};