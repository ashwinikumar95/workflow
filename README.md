# Workflow Builder

Full-stack workflow automation: design graphs in the browser, **publish** when ready, then run them via **webhook**, **cron**, or **Run now**. Executions are processed by a **BullMQ** worker and stored as **runs** with step logs.

---

## Features

| Area | What you get |
|------|----------------|
| **Editor** | Visual graph (XYFlow): add nodes, connect edges, configure each step. |
| **Lifecycle** | **Draft** → edit freely → **Publish** (graph frozen; only **rename** allowed after). |
| **Triggers** | **Webhook** (`POST /webhook/:id`, optional `x-webhook-secret`) or **Cron** (`trigger.config.cron`). Pause/resume via API. |
| **Execution** | Queue job on Redis → worker runs [src/services/executionEngine.js](src/services/executionEngine.js) → **Run** document with per-node logs. |
| **Nodes** | HTTP, Condition (branching), Delay (in-process, capped), Notify (Slack). |
| **Auth** | Register / login, JWT; workflows and runs scoped to the owner. |
| **Observability** | List runs per workflow, open a run for full log detail. |

---

## Tech stack

- **API:** Node.js, Express 5, Mongoose (MongoDB), JWT  
- **Jobs:** BullMQ + Redis (queue + worker in the same process as the API by default)  
- **Scheduler:** `node-cron` (syncs from DB when workflows change)  
- **UI:** React (Vite), React Router, `@xyflow/react`  

---

## Prerequisites

- **Node.js 18+**
- **MongoDB** (connection string)
- **Redis** (BullMQ)
- Optional: **Slack incoming webhook** URL for Notify + failure alerts

---

## Setup (local)

### 1. Backend

```bash
npm install
```

Create a **`.env`** file in the project root (same folder as `app.js`):

| Variable | Required | Description |
|----------|----------|-------------|
| `MONGODB_URI` | Yes | MongoDB connection string |
| `JWT_SECRET` | Yes | Secret for signing JWTs |
| `PORT` | No | API port (default `3000`) |
| `REDIS_HOST` | No | Default `127.0.0.1` |
| `REDIS_PORT` | No | Default `6379` |
| `REDIS_PASSWORD` | No | If your Redis needs auth |
| `SLACK_WEBHOOK_URL` | No | Notify node + optional failure notification |

Start API **and** worker (worker is loaded from `app.js`):

```bash
npm start
# or during development:
npm run dev
```

### 2. Frontend

```bash
cd frontend
npm install
cp .env.example .env
# Edit .env — set VITE_API_URL to your API origin, e.g. http://localhost:3000
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`). Register a user, create a workflow, then publish and trigger it.

### 3. API collection (optional)

Import [Workflow-Builder.postman_collection.json](Workflow-Builder.postman_collection.json) into Postman. Use the **Bearer token** from `/auth/login` for protected routes.

---

## How execution works

1. **Webhook** or **Run now** calls [enqueueWorkflowJob](src/services/enqueueWorkflowJob.js) → job lands on Redis queue `workflow-queue`.  
2. **Cron**: [schedulerService](src/services/schedulerService.js) registers a `node-cron` task per published cron workflow; each tick **enqueues** the same job (it does not call the engine directly).  
3. [worker.js](src/workers/worker.js) picks up jobs and runs `executeWorkflow`.  
4. Only **published** workflows run. **Paused** workflows (`trigger.enabled: false`) reject webhook/manual start; cron tasks are removed on resync while paused.  
5. Failed node steps are **retried** up to 3 times inside the engine; BullMQ also retries failed jobs per [queue.js](src/services/queue.js) defaults.

**Graph rules (enforced on publish):** at least one node, unique node ids, valid edges, exactly **one** start node (no incoming edges). Condition branches need two outgoing edges labeled `condition: "true"` and `"false"`.

---

## API reference

Send `Authorization: Bearer <token>` for all routes below except auth and webhook.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/register` | Create account; returns `token` + `user` |
| POST | `/auth/login` | Login; returns `token` + `user` |
| GET | `/user/profile` | Current user profile |
| PATCH | `/user/profile` | Update profile |
| GET | `/workflow` | List current user’s workflows |
| POST | `/workflow` | Create workflow (body: `name`, `nodes`, `edges`, `trigger`, …) |
| GET | `/workflow/:id` | Get one workflow |
| PATCH | `/workflow/:id` | Partial update (draft only; published: **name** only) |
| PUT | `/workflow/:id` | Replace document (draft only) |
| DELETE | `/workflow/:id` | Delete workflow |
| POST | `/workflow/:id/publish` | Validate graph + set `published` |
| PATCH | `/workflow/:id/trigger-enabled` | Body `{ "enabled": true \| false }` — pause/resume triggers |
| POST | `/workflow/:id/start` | Enqueue manual run; body = initial input JSON (`202` + `jobId`) |
| GET | `/workflow/:id/runs` | Paginated run history (`page`, `limit`) |
| GET | `/runs/:runId` | Run detail (logs, status) if run belongs to your workflow |
| POST | `/webhook/:workflowId` | **Public** trigger; optional header `x-webhook-secret` if configured |

---

## Node types (execution config)

| Type | Role | Config highlights |
|------|------|-------------------|
| **http** | Call an HTTP API | `method`, `url`, optional `headers` (object), `body` |
| **condition** | Branch true/false | `field` (dot path into payload), `operator`: `truthy` \| `exists` \| `equals`, `value` for `equals` |
| **delay** | Wait then pass data through | `seconds` (clamped **0–60**; uses in-process sleep — not a delayed queue job) |
| **notify** | Slack message | `message` with optional `{{dot.path}}` placeholders; skipped gracefully if `SLACK_WEBHOOK_URL` unset |

---

## Frontend routes

| Path | Purpose |
|------|---------|
| `/login`, `/register` | Auth |
| `/` | Dashboard (workflow list) |
| `/profile` | Profile |
| `/workflows/:id` | Editor |
| `/workflows/:id/runs` | Run history |
| `/workflows/:id/runs/:runId` | Run detail |

Webhook URL shown in the UI is derived from `VITE_API_URL` (see [frontend/src/lib/api.js](frontend/src/lib/api.js)).

---

## Known limitations

- **Loops**, **resume from failed step**, and **true delayed execution** (BullMQ delayed job / checkpoint) are not implemented.  
- **Scaling:** each API process runs `node-cron`; multiple instances without coordination will duplicate cron ticks — use a single scheduler role or move schedules to BullMQ repeatable jobs.  
- **Rate limiting / idempotency** for webhooks are not built in.  
- Published workflows: graph is **immutable** via API (only **name** can change).

---

## Project layout

```
app.js                 # Express app, Mongo connect, loads queue + worker
config/                # Env-backed config
src/
  controllers/         # HTTP handlers
  middlewares/        # JWT auth
  models/              # User, Workflow, Run, RevokedToken
  nodes/               # Node executors (http, condition, delay, notify)
  routes/              # Route modules
  services/            # Engine, queue, enqueue, triggers, scheduler
  utils/               # Graph validation, passwords, tokens, input validation
  workers/             # BullMQ consumer
frontend/              # Vite + React + XYFlow editor
docs/                  # Roadmap / internal notes
```

---

## Scripts

| Command | Where | Purpose |
|---------|--------|---------|
| `npm start` | root | Run API + worker |
| `npm run dev` | root | Same with nodemon |
| `npm run dev` | `frontend/` | Vite dev server |
| `npm run build` | `frontend/` | Production build |
| `npm run lint` | `frontend/` | ESLint |
