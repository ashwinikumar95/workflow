const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const { describe, test, before, after } = require("node:test");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const config = require("../config");
const User = require("../src/models/User");
const Workflow = require("../src/models/workflow");
const workflowRoutes = require("../src/routes/workflowRoutes");
const { connectTestDb, disconnectTestDb, clearTestData } = require("../test-support/helpers");

const SECRET = "whsec_test_value";
const AUTH = "Bearer leak-me";
const API_KEY = "token leak-me";

function assertNoSecrets(text) {
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes(AUTH), false);
  assert.equal(text.includes(API_KEY), false);
}

function workflowBody(extra = {}) {
  return {
    name: "redact",
    status: "draft",
    trigger: {
      type: "webhook",
      enabled: true,
      config: { secret: SECRET },
    },
    nodes: [
      {
        id: "http1",
        type: "http",
        config: {
          method: "GET",
          url: "https://example.com/hook",
          headers: {
            Authorization: AUTH,
            "X-Api-Key": API_KEY,
            "Content-Type": "application/json",
          },
          body: {},
        },
      },
    ],
    edges: [],
    ...extra,
  };
}

function assertRedacted(body) {
  const text = JSON.stringify(body);
  assertNoSecrets(text);
  const doc = Array.isArray(body) ? body[0] : body;
  assert.equal(doc.trigger.config.secretSet, true);
  assert.equal(doc.trigger.config.secret, undefined);
  const headers = doc.nodes[0].config.headers;
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers["X-Api-Key"], undefined);
  assert.equal(doc.nodes[0].config.secretSet["headers.Authorization"], true);
  assert.equal(doc.nodes[0].config.secretSet["headers.X-Api-Key"], true);
}

async function request(port, token, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
}

describe("phase 2 workflow credential redaction", () => {
  let server;
  let port;
  let token;
  let userId;

  before(async () => {
    await connectTestDb();
    await clearTestData();
    const user = await User.create({
      name: "Owner",
      email: `phase2-${Date.now()}@example.com`,
      password: "not-used-for-login",
    });
    userId = user._id;
    token = jwt.sign(
      { id: user._id.toString(), jti: crypto.randomUUID() },
      config.jwtSecret,
      { expiresIn: "1h" }
    );
    const app = express();
    app.use(express.json());
    app.use("/workflow", workflowRoutes);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (userId) await User.deleteOne({ _id: userId });
    const queuePath = require.resolve("../src/services/queue");
    if (require.cache[queuePath]) {
      await require(queuePath).close();
    }
    await disconnectTestDb();
  });

  test("workflow JSON omits secrets and a redacted update keeps them", async () => {
    const created = await request(port, token, "POST", "/workflow", workflowBody());
    assert.equal(created.status, 201);
    assertRedacted(created.json);
    const id = created.json._id;

    const listed = await request(port, token, "GET", "/workflow");
    assert.equal(listed.status, 200);
    assertNoSecrets(listed.text);
    assertRedacted(listed.json);

    const fetched = await request(port, token, "GET", `/workflow/${id}`);
    assert.equal(fetched.status, 200);
    assertRedacted(fetched.json);

    const replaced = await request(port, token, "PUT", `/workflow/${id}`, workflowBody({ name: "redact" }));
    assert.equal(replaced.status, 200);
    assertRedacted(replaced.json);

    const omitted = await request(port, token, "PATCH", `/workflow/${id}`, {
      name: "redact",
      status: "draft",
      trigger: { type: "webhook", enabled: true, config: { secretSet: true } },
      nodes: [
        {
          id: "http1",
          type: "http",
          config: {
            method: "GET",
            url: "https://example.com/hook",
            headers: { "Content-Type": "application/json" },
            body: {},
            secretSet: {
              "headers.Authorization": true,
              "headers.X-Api-Key": true,
            },
          },
        },
      ],
      edges: [],
    });
    assert.equal(omitted.status, 200);
    assertRedacted(omitted.json);

    const stored = await Workflow.findById(id).lean();
    assert.equal(stored.trigger.config.secret, SECRET);
    assert.equal(stored.nodes[0].config.headers.Authorization, AUTH);
    assert.equal(stored.nodes[0].config.headers["X-Api-Key"], API_KEY);
    assert.equal(stored.nodes[0].config.headers["Content-Type"], "application/json");
    assert.equal(stored.trigger.config.secretSet, undefined);
    assert.equal(stored.nodes[0].config.secretSet, undefined);

    const published = await request(port, token, "POST", `/workflow/${id}/publish`);
    assert.equal(published.status, 200);
    assertRedacted(published.json);

    const toggled = await request(port, token, "PATCH", `/workflow/${id}/trigger-enabled`, {
      enabled: false,
    });
    assert.equal(toggled.status, 200);
    assertRedacted(toggled.json);
    assert.equal(mongoose.Types.ObjectId.isValid(id), true);
  });
});
