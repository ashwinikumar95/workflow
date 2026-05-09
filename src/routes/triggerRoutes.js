const express = require("express");
const router = express.Router();
const { handleWebhook } = require("../controllers/triggerController");

router.post("/webhook/:id", handleWebhook);

module.exports = router;