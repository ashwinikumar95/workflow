import fs from "fs/promises";
import path from "path";

/**
 * Runs inside the agent container. The host worker does not import this file.
 * There is no `cloud` runtime. Ticket text is only the prompt string.
 */
export async function runSandbox({
  Agent,
  apiKey,
  modelId,
  cwd,
  prompt,
  agentExecutionId,
  writeReceipt,
  settingSources,
}) {
  const agent = await Agent.create({
    apiKey,
    model: { id: modelId || process.env.CURSOR_MODEL || "composer-2.5" },
    local: {
      cwd,
      settingSources:
        Array.isArray(settingSources) && settingSources.length ? settingSources : ["project"],
    },
  });
  try {
    const run = await agent.send(prompt);
    const receipt = {
      agentId: agent.agentId,
      runId: run.id,
      agentExecutionId: agentExecutionId || null,
    };
    if (writeReceipt) {
      await writeReceipt(receipt);
    } else {
      const dir = path.join(cwd, ".workflow");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "agent-execution.json"), JSON.stringify(receipt));
    }
    return await run.wait();
  } finally {
    if (agent && typeof agent[Symbol.asyncDispose] === "function") {
      await agent[Symbol.asyncDispose]();
    }
  }
}
