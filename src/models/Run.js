const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const runSchema = new mongoose.Schema({
  workflowId: mongoose.Schema.Types.ObjectId,

  /** Queue / client id, or UUID from `resolveJobId` — always set on new runs */
  jobId: { type: String, unique: true ,default: () => uuidv4()},

  status: {
    type: String,
    enum: ["running", "success", "failed"],
    default: "running"
  },

  startedAt: Date,
  endedAt: Date,

  logs: [
    {
      nodeId: String,
      status: String,
      input: Object,
      output: Object,
      duration: Number,
      error: String
    }
  ]
}, { timestamps: true });

module.exports = mongoose.models.Run || mongoose.model("Run", runSchema);