const mongoose = require("mongoose");
const Workflow = require("../src/models/workflow");

function assertTestDatabase() {
  const name = mongoose.connection.name || "";
  if (!name.endsWith("_test")) {
    throw new Error(`Refusing to use MongoDB database "${name || "(missing)"}"`);
  }
}

async function connectTestDb() {
  if (mongoose.connection.readyState === 1) {
    assertTestDatabase();
    return;
  }
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
  });
  assertTestDatabase();
}

async function disconnectTestDb() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

async function clearTestData() {
  assertTestDatabase();
  await mongoose.connection.collection("runs").deleteMany({});
  await mongoose.connection.collection("workflows").deleteMany({});
  const extras = ["ticketruns", "resourcelocks", "slack_outbox"];
  for (const name of extras) {
    try {
      await mongoose.connection.collection(name).deleteMany({});
    } catch {
      // collection may not exist yet
    }
  }
}

async function createPublishedWorkflow(nodes, edges) {
  return Workflow.create({
    name: "phase1",
    status: "published",
    nodes,
    edges: edges || [],
    trigger: { type: "webhook", enabled: true, config: {} },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function poll(read, timeoutMs = 8000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await read();
    if (last) return last;
    await sleep(10);
  }
  const err = new Error("timed out waiting for condition");
  err.last = last;
  throw err;
}

module.exports = {
  assertTestDatabase,
  connectTestDb,
  disconnectTestDb,
  clearTestData,
  createPublishedWorkflow,
  sleep,
  poll,
};
