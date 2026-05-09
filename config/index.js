const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

module.exports = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV || "development",
  uploadsDir: path.join(__dirname, "..", "uploads"),
  mongodbUri: process.env.MONGODB_URI,
  jwtSecret: process.env.JWT_SECRET,

  /** Optional: Slack incoming webhook for Notify node + run failure alerts */
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || undefined,

  /** BullMQ / ioredis — used by `src/services/queue.js` and `src/workers/worker.js` */
  redisHost: process.env.REDIS_HOST || "127.0.0.1",
  redisPort: Number(process.env.REDIS_PORT) || 6379,
  redisPassword: process.env.REDIS_PASSWORD || undefined,

  get redisConnection() {
    const c = {
      host: this.redisHost,
      port: this.redisPort
    };
    if (this.redisPassword) c.password = this.redisPassword;
    return c;
  }
};
