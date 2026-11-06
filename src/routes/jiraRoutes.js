const express = require("express");
const auth = require("../middlewares/authMiddleware");
const { runIssue } = require("../controllers/jiraController");

const router = express.Router();
router.use(auth);
router.post("/run", runIssue);

module.exports = router;
