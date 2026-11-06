const express = require("express");
const auth = require("../middlewares/authMiddleware");
const { getRunById, decideRun, cancelRun, retryRun } = require("../controllers/RunController");

const router = express.Router();
router.use(auth);
router.get("/:runId", getRunById);
router.post("/:runId/decision", decideRun);
router.post("/:runId/cancel", cancelRun);
router.post("/:runId/retry", retryRun);

module.exports = router;
