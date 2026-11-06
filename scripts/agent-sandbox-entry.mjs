import fs from "fs/promises";
import path from "path";
import { Agent, CursorAgentError } from "@cursor/sdk";
import { runSandbox } from "./agent-sandbox-lib.mjs";

export { runSandbox, CursorAgentError };

const isMain = process.argv[1] && process.argv[1].endsWith("agent-sandbox-entry.mjs");

async function writeReceiptFile(file, receipt) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(receipt));
}

async function readPrompt() {
  const promptPath = process.env.WORKFLOW_PROMPT_PATH || "";
  if (promptPath) return fs.readFile(promptPath, "utf8");
  return process.env.WORKFLOW_PROMPT || "";
}

if (isMain) {
  const apiKey = process.env.CURSOR_API_KEY;
  const receiptFile = process.env.WORKFLOW_RECEIPT_PATH || "";
  readPrompt()
    .then((prompt) =>
      runSandbox({
        Agent,
        apiKey,
        modelId: process.env.CURSOR_MODEL || "composer-2.5",
        cwd: process.env.WORKFLOW_CWD || "/worktree",
        prompt,
        agentExecutionId: process.env.WORKFLOW_AGENT_EXECUTION_ID,
        settingSources: ["project"],
        writeReceipt: receiptFile ? (receipt) => writeReceiptFile(receiptFile, receipt) : undefined,
      })
    )
    .catch((err) => {
      const retryable = err instanceof CursorAgentError && err.retryable === true;
      process.stderr.write(err && err.message ? err.message : "agent failed");
      process.exit(retryable ? 75 : 1);
    });
}
