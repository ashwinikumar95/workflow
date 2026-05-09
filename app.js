const path = require("path");
const express = require("express");
const mongoose = require("mongoose");
const config = require("./config");
const cors = require("cors");
const workflowRoutes = require("./src/routes/WorkflowRoutes");
const triggerRoutes = require("./src/routes/triggerRoutes");
const userRoutes = require("./src/routes/userRoutes");
const authRoutes = require("./src/routes/authRoutes");
const runRoutes = require("./src/routes/runRoutes");
const { startScheduler } = require("./src/services/schedulerService");

require("./src/services/queue");
require("./src/workers/worker");

const app = express();

app.use(cors());
app.use(express.json());
startScheduler();
app.use("/auth", authRoutes);
app.use("/workflow", workflowRoutes);
app.use("/", triggerRoutes);
app.use("/user", userRoutes);
app.use("/runs", runRoutes);
app.get("/", (req, res) => {
  res.send("Workflow Builder API Running");
});

mongoose
  .connect(config.mongodbUri)
  .then(() => {
    app.listen(config.port, () => {
      console.log(`Server listening on http://localhost:${config.port}`);
    });
  })
  .catch((err) => {
    console.error("MongoDB connection failed:", err);
    process.exit(1);
  });
