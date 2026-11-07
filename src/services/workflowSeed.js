const fs = require("fs");
const path = require("path");
const Workflow = require("../models/workflow");
const User = require("../models/User");
const { parseProfiles } = require("./projectRegistry");
const { buildProjectWorkflow } = require("./workflowTemplate");
const { normalizeEmail } = require("../utils/userInput");

const SEED_FILE = path.join(__dirname, "..", "..", "config", "workflow-seeds.json");

function loadSeedDefs() {
  return JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
}

function ownerEmail() {
  return normalizeEmail(process.env.WORKFLOW_OWNER_EMAIL || process.env.JIRA_EMAIL || "");
}

function graphForSeed(seed, profiles) {
  const key = seed.intake === "manual" ? "MF" : seed.profileKeys[0];
  const profile = profiles[key];
  if (!profile) throw new Error(`Unknown profile ${key} for seed ${seed.seedKey}`);
  const linked = profiles[profile.linkedProfile];
  return buildProjectWorkflow(profile, linked);
}

function triggerFromSeed(seed) {
  const config = { ...(seed.trigger && seed.trigger.config ? seed.trigger.config : {}) };
  config.seedKey = seed.seedKey;
  config.intake = seed.intake;
  config.profileKeys = seed.profileKeys;
  return {
    type: seed.trigger.type,
    enabled: seed.trigger.enabled !== false,
    config,
  };
}

async function seedDraftWorkflows(deps = {}) {
  const UserModel = deps.User || User;
  const WorkflowModel = deps.Workflow || Workflow;
  const email = ownerEmail();
  if (!email) {
    console.warn("[workflow-seed] No WORKFLOW_OWNER_EMAIL or JIRA_EMAIL; skip");
    return { skipped: true, reason: "missing_owner" };
  }
  const user = await UserModel.findOne({ email });
  if (!user) {
    console.warn(`[workflow-seed] No user for ${email}; skip`);
    return { skipped: true, reason: "missing_user", email };
  }
  const profiles = deps.profiles || parseProfiles();
  const defs = deps.seeds || loadSeedDefs();
  const created = [];
  const kept = [];
  const repaired = [];
  for (const seed of defs) {
    const byKey = await WorkflowModel.findOne({
      userId: user._id,
      "trigger.config.seedKey": seed.seedKey,
    });
    const stripped = await WorkflowModel.findOne({
      userId: user._id,
      name: seed.name,
      $or: [
        { "trigger.config.seedKey": { $exists: false } },
        { "trigger.config.seedKey": null },
        { "trigger.config.seedKey": "" },
      ],
    });
    if (stripped) {
      const plain = stripped.toObject();
      const prior =
        plain.trigger && plain.trigger.config && typeof plain.trigger.config === "object"
          ? plain.trigger.config
          : {};
      await WorkflowModel.updateOne(
        { _id: stripped._id },
        {
          $set: {
            "trigger.config": {
              ...prior,
              seedKey: seed.seedKey,
              intake: seed.intake,
              profileKeys: seed.profileKeys,
            },
          },
        }
      );
      repaired.push({ seedKey: seed.seedKey, id: String(stripped._id), status: stripped.status });
      console.log(`[workflow-seed] Restored trigger identity ${seed.seedKey} (${stripped._id})`);
      if (
        byKey &&
        String(byKey._id) !== String(stripped._id) &&
        byKey.status === "draft" &&
        byKey.name === seed.name
      ) {
        await WorkflowModel.deleteOne({ _id: byKey._id, userId: user._id, status: "draft" });
        console.log(`[workflow-seed] Removed duplicate draft ${seed.seedKey} (${byKey._id})`);
      }
      continue;
    }
    if (byKey) {
      kept.push({ seedKey: seed.seedKey, id: String(byKey._id), status: byKey.status });
      continue;
    }
    const graph = graphForSeed(seed, profiles);
    const doc = await WorkflowModel.create({
      name: seed.name,
      status: "draft",
      userId: user._id,
      profileKey: seed.intake === "bucket" ? seed.profileKeys[0] : undefined,
      runtime: graph.runtime,
      retention: graph.retention,
      repository: graph.repository,
      nodes: graph.nodes,
      edges: graph.edges,
      trigger: triggerFromSeed(seed),
    });
    created.push({ seedKey: seed.seedKey, id: String(doc._id) });
    console.log(`[workflow-seed] Restored draft ${seed.seedKey} (${doc._id})`);
  }
  return { skipped: false, email, created, kept, repaired };
}

module.exports = { seedDraftWorkflows, loadSeedDefs, ownerEmail, SEED_FILE };
