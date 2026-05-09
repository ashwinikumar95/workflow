const express = require("express");
const auth = require("../middlewares/authMiddleware");
const { getRunById } = require("../controllers/RunController");

const router = express.Router();
router.use(auth);
router.get("/:runId", getRunById);

module.exports = router;
