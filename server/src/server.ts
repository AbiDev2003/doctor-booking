import { createApp } from "./app.js";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";

const app = createApp();

app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.CLIENT_URL }, "server listening");
});
