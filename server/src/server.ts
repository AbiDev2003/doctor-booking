import { createApp } from "./app.js";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { runStartupJobs, startScheduler } from "./jobs/scheduler.js";

const app = createApp();

async function bootstrap() {
  await runStartupJobs(new Date());
  app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.CLIENT_URL }, "server listening");
    startScheduler();
  });
}

bootstrap().catch((err) => {
  logger.error({ err }, "failed to start server");
  process.exit(1);
});
