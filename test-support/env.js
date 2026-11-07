const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  const parsed = dotenv.parse(fs.readFileSync(envPath));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

process.env.WORKFLOW_WORKER_AUTOSTART = "false";

function databaseName(uri) {
  if (!uri) return "";
  const withoutQuery = String(uri).split("?")[0];
  const slash = withoutQuery.lastIndexOf("/");
  if (slash < 0 || slash === withoutQuery.length - 1) return "";
  return withoutQuery.slice(slash + 1);
}

const name = databaseName(process.env.MONGODB_URI || "");
if (!name.endsWith("_test")) {
  console.error(
    `Refusing to start tests: MongoDB database "${name || "(missing)"}" does not end in _test`
  );
  process.exit(1);
}
