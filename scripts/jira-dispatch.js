const mongoose = require("mongoose");
const config = require("../config");
const { dispatch } = require("../src/services/jiraDispatcher");

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (!config.mongodbUri) {
    throw new Error("MONGODB_URI is not set");
  }
  await mongoose.connect(config.mongodbUri);
  try {
    const result = await dispatch({ dryRun });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
