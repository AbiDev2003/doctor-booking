import { pino } from "pino";

export const logger = pino({
  level: "info",
  base: { service: "doctor-booking-api" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers[\"set-cookie\"]",
      "password",
      "*.password",
    ],
    censor: "[redacted]",
  },
});
