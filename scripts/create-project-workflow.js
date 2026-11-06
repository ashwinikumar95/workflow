const mongoose = require("mongoose");
const config = require("../config");
const Workflow = require("../src/models/workflow");
const { parseProfiles } = require("../src/services/projectRegistry");
const { buildProjectWorkflow } = require("../src/services/workflowTemplate");
const { validateWorkflowGraph } = require("../src/utils/workflowGraph");

async function main() {
  const key = String(process.argv[2] || "").trim().toUpperCase();
  if (!key) {
    throw new Error("Usage: node scripts/create-project-workflow.js <KEY>");
  }
  const profiles = parseProfiles();
  const profile = profiles[key];
  if (!profile) throw new Error(`Unknown profile ${key}`);
  const linked = profiles[profile.linkedProfile];
  const graph = buildProjectWorkflow(profile, linked);
  const check = validateWorkflowGraph(graph);
  if (!check.ok) throw new Error(check.message);

  if (!config.mongodbUri) throw new Error("MONGODB_URI is not set");
  await mongoose.connect(config.mongodbUri);
  try {
    const payload = {
      name: graph.name,
      status: "published",
      profileKey: profile.jiraKey,
      runtime: "host",
      retention: graph.retention,
      repository: graph.repository,
      nodes: graph.nodes,
      edges: graph.edges,
    };
    const existing = await Workflow.findOne({ profileKey: profile.jiraKey, status: "published" }).sort({
      updatedAt: -1,
    });
    let doc;
    if (existing) {
      const trigger = existing.trigger || { type: "webhook", enabled: true, config: {} };
      await Workflow.updateOne({ _id: existing._id }, { $set: { ...payload, trigger } });
      doc = await Workflow.findById(existing._id);
    } else {
      doc = await Workflow.create({
        ...payload,
        trigger: { type: "webhook", enabled: true, config: {} },
      });
    }
    console.log(JSON.stringify({ workflowId: String(doc._id), profileKey: profile.jiraKey, name: doc.name }, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
