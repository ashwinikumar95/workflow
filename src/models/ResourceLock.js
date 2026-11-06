const mongoose = require("mongoose");

const resourceLockSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    owner: { type: String, required: true },
    token: { type: String, required: true },
    acquiredAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { collection: "resourcelocks" }
);

module.exports =
  mongoose.models.ResourceLock || mongoose.model("ResourceLock", resourceLockSchema);
