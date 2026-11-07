const { startFromIssue } = require("../services/jiraDispatcher");

exports.runIssue = async (req, res) => {
  try {
    const issue = req.body && req.body.issue;
    const result = await startFromIssue(issue);
    res.status(202).json({
      runId: result.runId,
      jobId: result.jobId,
      jiraKey: result.jiraKey,
      profileKey: result.profileKey,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    const body = { error: err.message };
    if (err.reason) body.reason = err.reason;
    if (err.jiraKey) body.jiraKey = err.jiraKey;
    if (err.runId) body.runId = err.runId;
    res.status(status).json(body);
  }
};
