const express = require("express");
const router = express.Router();
const auth = require("../middlewares/authMiddleware");
const {
  createWorkflow,
  listWorkflows,
  getWorkflowById,
  setTriggerEnabled,
  updateWorkflow,
  replaceWorkflow,
  deleteWorkflow,
  publishWorkflow,
  startWorkflow
} = require("../controllers/WorkflowController");
const { listRunsForWorkflow } = require("../controllers/RunController");

router.post("/", auth, createWorkflow);
router.get("/", auth, listWorkflows);
router.get("/:id/runs", auth, listRunsForWorkflow);
router.patch("/:id/trigger-enabled", auth, setTriggerEnabled);
router.post("/:id/publish", auth, publishWorkflow);
router.post("/:id/start", auth, startWorkflow);
router.get("/:id", auth, getWorkflowById);
router.patch("/:id", auth, updateWorkflow);
router.put("/:id", auth, replaceWorkflow);
router.delete("/:id", auth, deleteWorkflow);

module.exports = router;
