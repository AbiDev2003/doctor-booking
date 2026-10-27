import { materializeSlots } from "../services/slots/slotGeneration.service.js";

export async function runSlotGeneration() {
  return materializeSlots();
}
