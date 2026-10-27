import { materializeSlots } from "../services/slotGeneration.service.js";

export async function runSlotGeneration() {
  return materializeSlots();
}
