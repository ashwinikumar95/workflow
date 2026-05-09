const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const Workflow = require("../models/Workflow");
const Run = require("../models/Run");
const config = require("../../config");
const { executeNode } = require("../nodes");

function resolveJobId(jobId) {
  if (jobId != null && String(jobId).trim() !== "") {
    return String(jobId);
  }
  return uuidv4();
}

// 🔁 Retry wrapper
async function executeWithRetry(node, input, retries = 3) {
  let lastError;

  for (let i = 0; i < retries; i++) {
    try {
      return await executeNode(node, input);
    } catch (err) {
      lastError = err;
      console.log(`Retry ${i + 1} failed for node ${node.id}`);
    }
  }

  throw lastError;
}

// 🔀 Branching logic
function getNextNode(workflow, currentNode, result) {
  const edges = workflow.edges.filter(e => e.from === currentNode.id);

  if (edges.length === 0) return null;

  // linear
  if (edges.length === 1) {
    return workflow.nodes.find(n => n.id === edges[0].to);
  }

  // branching
  const edge =
    result === true
      ? edges.find((e) => e.condition === "true")
      : edges.find((e) => e.condition === "false");
  if (!edge) {
    throw new Error(
      "Branching requires two outgoing edges labeled true and false"
    );
  }
  const next = workflow.nodes.find((n) => n.id === edge.to);
  if (!next) {
    throw new Error("Branch edge points to unknown node");
  }
  return next;
}

async function maybeNotifyRunFailure(workflowId, message) {
  const url = config.slackWebhookUrl;
  if (!url) return;
  try {
    await axios.post(
      url,
      { text: `Workflow run failed (${String(workflowId)}): ${message}` },
      { timeout: 8000 }
    );
  } catch (e) {
    console.error("[executeWorkflow] Failure notify to Slack failed:", e.message);
  }
}

// 🚀 MAIN EXECUTION (called by worker or directly e.g. webhook)
async function executeWorkflow(workflowId, inputData = {}, jobId) {
  const resolvedJobId = resolveJobId(jobId);
  const jobIdSource =
    jobId != null && String(jobId).trim() !== ""
      ? "queue-or-provided"
      : "uuid-generated";

  console.log(
    "[executeWorkflow] Executing workflow:",
    String(workflowId),
    "jobId:",
    resolvedJobId,
    `(${jobIdSource})`
  );

  const workflow = await Workflow.findById(workflowId);

  if (!workflow) throw new Error("Workflow not found");

  if (workflow.status !== "published") {
    throw new Error("Workflow not published");
  }

  const run = await Run.create({
    workflowId,
    jobId: resolvedJobId,
    status: "running",
    startedAt: new Date(),
    logs: []
  });

  try {
    // 🔍 Find start node
    let currentNode = workflow.nodes.find(n =>
      !workflow.edges.some(e => e.to === n.id)
    );

    if (!currentNode) {
      throw new Error("No start node found");
    }

    while (currentNode) {

      const startTime = Date.now();

      try {
        const output = await executeWithRetry(currentNode, inputData);

        run.logs.push({
          nodeId: currentNode.id,
          status: "success",
          input: JSON.stringify(inputData).slice(0, 200),
          output: JSON.stringify(output).slice(0, 200),
          duration: Date.now() - startTime
        });

        inputData = output;

        currentNode = getNextNode(workflow, currentNode, output);

      } catch (err) {

        run.logs.push({
          nodeId: currentNode.id,
          status: "failed",
          error: err.message,
          input: JSON.stringify(inputData).slice(0, 200)
        });

        throw err; // 🔥 IMPORTANT: let worker handle failure
      }
    }

    run.status = "success";
    run.endedAt = new Date();
    await run.save();

    console.log("Workflow completed:", workflowId);

  } catch (err) {

    run.status = "failed";
    run.endedAt = new Date();

    run.logs.push({
      status: "failed",
      error: err.message
    });

    await run.save();

    console.error("Workflow failed:", err.message);

    await maybeNotifyRunFailure(workflowId, err.message);

    throw err; // 🔥 let queue mark job as failed
  }
}

module.exports = { executeWorkflow };