const mongoose = require("mongoose");

const workflowSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },

  status: {
    type: String,
    enum: ["draft", "published"],
    default: "draft"
  },

  userId: mongoose.Schema.Types.ObjectId,

  trigger: {
    type: {
      type: String,
      enum: ["webhook", "cron"]
    },
    /** When false, cron schedules are not registered (webhook triggers ignore this). */
    enabled: {
      type: Boolean,
      default: true
    },
    config: {
      type: Object
    }
  },

  nodes: [
    {
      id: String,
      type: { type: String },
      config: Object
    }
  ],

  edges: [
    {
      from: String,
      to: String,
      condition: String // "true" | "false"
    }
  ],

  /**
   * Functional repository for this workflow. `credentialRef` is an environment
   * variable name on the workflow worker, not the secret value.
   */
  repository: {
    location: String,
    defaultBranch: String,
    credentialRef: String,
  },

  retention: {
    keepWorktreeOnFailure: { type: Boolean, default: false },
    worktreeDays: { type: Number, default: 7 },
  },

  runtime: {
    type: String,
    enum: ["docker", "host"],
  },
}, { timestamps: true });

module.exports =
  mongoose.models.Workflow || mongoose.model("Workflow", workflowSchema);