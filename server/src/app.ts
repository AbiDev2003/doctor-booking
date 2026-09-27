import express from "express";
import cors from "cors";
import { pinoHttp } from "pino-http";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { genRequestId, requestId } from "./middleware/requestId.js";
import { notFound } from "./middleware/notFound.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { healthRouter } from "./routes/health.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");

  app.use(
    pinoHttp({
      logger,
      genReqId: genRequestId,
      customProps: (req) => ({ requestId: req.id }),

      serializers: {
        req: (req) => ({ method: req.method, url: req.url }),
      },
    }),
  );
  app.use(requestId);

  app.use(cors({ origin: config.CLIENT_URL, credentials: true }));
  app.use(express.json({ limit: "1mb" }));

  app.use("/api/v1/health", healthRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
