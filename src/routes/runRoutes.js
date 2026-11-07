const express = require("express");
const auth = require("../middlewares/authMiddleware");
const { getRunById, decideRun } = require("../controllers/RunController");

const router = express.Router();
router.use(auth);
router.get("/:runId", getRunById);
router.post("/:runId/decision", decideRun);

module.exports = router;
