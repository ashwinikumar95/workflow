const mongoose = require("mongoose");

const TICKET_STATES = [
  "claimed",
  "planning",
  "awaiting_approval",
  "queued",
  "implementing",
  "verifying",
  "pr_open",
  "completed",
  "blocked",
  "rejected",
  "cancelled",
  "failed",
  "interrupted",
  "skipped",
  "expired",
];

const TERMINAL_STATES = [
  "completed",
  "blocked",
  "rejected",
  "cancelled",
  "failed",
  "skipped",
];

const LIVE_STATES = TICKET_STATES.filter((state) => !TERMINAL_STATES.includes(state));

const ticketRunSchema = new mongoose.Schema(
  {
    jiraKey: { type: String, required: true },
    profileKey: { type: String, required: true },
    runId: { type: String, required: true },
    fingerprint: String,
    planHash: String,
    state: {
      type: String,
      enum: TICKET_STATES,
      required: true,
      default: "claimed",
    },
    stage: { type: String, default: "claimed" },
    prUrl: String,
    linkedPrUrl: String,
    failureReason: String,
    lockToken: String,
    checkpointSha: String,
    testedSha: String,
    worktreePath: String,
    branch: String,
    selection: mongoose.Schema.Types.Mixed,
    processes: [
      {
        pid: Number,
        startedAt: Date,
        role: String,
      },
    ],
  },
  { timestamps: true }
);

ticketRunSchema.index(
  { jiraKey: 1 },
  {
    unique: true,
    name: "ticketruns_live_jiraKey",
    partialFilterExpression: {
      state: { $in: LIVE_STATES },
    },
  }
);

ticketRunSchema.index({ runId: 1 });

module.exports = mongoose.models.TicketRun || mongoose.model("TicketRun", ticketRunSchema);
module.exports.TICKET_STATES = TICKET_STATES;
module.exports.TERMINAL_STATES = TERMINAL_STATES;
module.exports.LIVE_STATES = LIVE_STATES;
