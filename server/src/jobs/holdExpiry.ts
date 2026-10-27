import { $Enums } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { AppError } from "../lib/appError.js";
import { writeAudit } from "../services/audit.service.js";

export async function expireStaleHolds(now: Date): Promise<number> {
  try {
    const holds = await prisma.seatHold.findMany({
      where: {
        releasedAt: null,
        expiresAt: { lte: now },
      },
      include: {
        slot: true,
      },
    });

    let released = 0;
    for (const hold of holds) {
      try {
        const result = await prisma.$transaction(async (tx) => {
          const holdRow = await tx.seatHold.findUnique({
            where: { id: hold.id },
            select: { id: true, releasedAt: true, slotId: true, patientId: true },
          });
          if (!holdRow || holdRow.releasedAt !== null) {
            return 0;
          }

          await tx.seatHold.update({
            where: { id: hold.id },
            data: {
              releasedAt: now,
              releaseReason: $Enums.SeatHoldReleaseReason.EXPIRED,
            },
          });

          if (hold.slot) {
            await tx.slot.updateMany({
              where: { id: hold.slotId, heldCount: { gt: 0 } },
              data: { heldCount: { decrement: 1 } },
            });
          }

          // Best effort: void pending payment tied to this hold if exists
          const payment = await tx.payment.findFirst({
            where: { patientId: hold.patientId, status: $Enums.PaymentStatus.PENDING },
            orderBy: { createdAt: "desc" },
            select: { id: true },
          });
          if (payment) {
            await tx.payment.updateMany({
              where: { id: payment.id, status: $Enums.PaymentStatus.PENDING },
              data: { status: $Enums.PaymentStatus.VOIDED },
            });
            try {
              await writeAudit(tx, {
                action: "PAYMENT_VOIDED",
                targetType: "payment",
                targetId: payment.id,
                actor: { id: "system", role: $Enums.UserRole.ADMIN, name: "system" },
                before: { status: $Enums.PaymentStatus.PENDING },
                after: { status: $Enums.PaymentStatus.VOIDED, reason: "HOLD_EXPIRED" },
                reason: "Seat hold expired",
              });
            } catch (e) {
              // ignore audit failures
            }
          }

          return 1;
        });

        released += result;
      } catch (err) {
        logger.error({ err, holdId: hold.id }, "hold expiry failed for hold");
      }
    }
    return released;
  } catch (err) {
    logger.error({ err }, "hold expiry job crashed");
    return 0;
  }
}
