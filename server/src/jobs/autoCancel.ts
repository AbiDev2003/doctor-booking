import { autoCancelAfterSlotEnd } from "../services/appointmentCascade.service.js";

export async function runAutoCancel(now: Date) {
  return autoCancelAfterSlotEnd(now);
}
