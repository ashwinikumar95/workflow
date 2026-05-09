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
  ]
}, { timestamps: true });

module.exports =
  mongoose.models.Workflow || mongoose.model("Workflow", workflowSchema);