import { logger } from "../lib/logger.js";
import { expireStaleHolds } from "./holdExpiry.js";
import { sendAppointmentReminders } from "./reminders.js";
import { runAutoCancel } from "./autoCancel.js";
import { runSlotGeneration } from "./slotGenerator.js";

let started = false;
const intervals: ReturnType<typeof setInterval>[] = [];

export async function runStartupJobs(now: Date = new Date()): Promise<void> {
  try {
    await expireStaleHolds(now);
    logger.info("startup hold-expiry sweep completed");
  } catch (err) {
    logger.error({ err }, "startup hold-expiry sweep failed");
  }
}

export function startScheduler(): void {
  if (started) return;
  started = true;

  // Run reminders every 60s
  const remindersInterval = setInterval(() => {
    void sendAppointmentReminders(new Date()).catch((err) => {
      logger.error({ err }, "reminders interval crashed");
    });
  }, 60 * 1000);
  intervals.push(remindersInterval);

  // Run auto-cancel every 60s
  const autoCancelInterval = setInterval(() => {
    void runAutoCancel(new Date()).catch((err) => {
      logger.error({ err }, "auto-cancel interval crashed");
    });
  }, 60 * 1000);
  intervals.push(autoCancelInterval);

  // Run slot generation every 5 minutes
  const slotGenInterval = setInterval(() => {
    void runSlotGeneration().catch((err) => {
      logger.error({ err }, "slot generation interval crashed");
    });
  }, 5 * 60 * 1000);
  intervals.push(slotGenInterval);

  // Run hold expiry periodically
  const holdExpiryInterval = setInterval(() => {
    void expireStaleHolds(new Date()).catch((err) => {
      logger.error({ err }, "hold expiry interval crashed");
    });
  }, 60 * 1000);
  intervals.push(holdExpiryInterval);

  logger.info("in-process scheduler started");
}

export function stopScheduler(): void {
  for (const interval of intervals) {
    clearInterval(interval);
  }
  intervals.length = 0;
  started = false;
}
