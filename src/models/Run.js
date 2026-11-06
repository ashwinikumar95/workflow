const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const runSchema = new mongoose.Schema({
  workflowId: mongoose.Schema.Types.ObjectId,

  /** Queue / client id, or UUID from `resolveJobId` — always set on new runs */
  jobId: { type: String, unique: true ,default: () => uuidv4()},

  status: {
    type: String,
    enum: ["running", "success", "failed", "waiting", "interrupted", "cancelled"],
    default: "running"
  },

  /** Node about to run. Absent on rows written before checkpoints existed. */
  currentNodeId: String,

  /** Full payload. Step logs keep a short preview and are not a cursor. */
  context: mongoose.Schema.Types.Mixed,

  /** Token of the attempt that currently owns this row. */
  executionClaim: String,

  /** Lease deadline assigned from MongoDB `$$NOW` during claim, renew, and checkpoint. */
  executionClaimExpiresAt: Date,

  /** Active pause. Replaced when the run starts a later wait. */
  wait: mongoose.Schema.Types.Mixed,

  /** Winning approval decision for the current wait. Absent until that update. */
  approval: mongoose.Schema.Types.Mixed,

  /** Resume outbox. `enqueuedAt` stays null until the resume job is added. */
  pendingResume: mongoose.Schema.Types.Mixed,

  /** Later lifecycle fields (worktree, agent, Playwright). Redacted on read. */
  external: mongoose.Schema.Types.Mixed,

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