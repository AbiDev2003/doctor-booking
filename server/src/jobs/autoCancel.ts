import { autoCancelAfterSlotEnd } from "../services/appointments/appointmentCascade.service.js";

export async function runAutoCancel(now: Date) {
  return autoCancelAfterSlotEnd(now);
}
