import { $Enums } from "../generated/prisma/client.js";
import { config } from "../config.js";
import { prisma, isUniqueConstraintViolation } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { appointmentAttendanceFollowUpEmail } from "../lib/emailTemplates.js";
import { utcToLocalDateTime } from "../lib/time.js";
import { getClinicSettings } from "../services/clinic.service.js";
import {
  dispatchNotificationInBackground,
  hasNotification,
  queueNotification,
} from "../services/notifications/notification.service.js";

function slotDateTimeLocal(slot: { slotDate: Date; startTime: Date; endTime: Date }, timezone: string) {
  const date = utcToLocalDateTime(new Date(slot.slotDate.getTime()), timezone).date;
  return {
    date,
    start: slot.startTime.toISOString().slice(11, 16),
    end: slot.endTime.toISOString().slice(11, 16),
  };
}

/**
 * A staff/admin nudge for bookings that are still CONFIRMED after their slot
 * ended. Read-only on appointments: attendance stays a human decision.
 *
 * Idempotency is both an app-level check and a DB partial unique index on
 * `(appointment_id, recipient)` for this notification type, so two overlapping
 * scheduler ticks cannot double-email the same desk member.
 */
export async function sendUnclosedBookingReminders(now: Date = new Date()): Promise<number> {
  try {
    const clinic = await getClinicSettings();
    const minutes = clinic.unclosedBookingReminderMinutes ?? 180;
    const cutoff = new Date(now.getTime() - minutes * 60 * 1000);

    const [appointments, staff] = await Promise.all([
      prisma.appointment.findMany({
        where: {
          status: $Enums.AppointmentStatus.CONFIRMED,
          slot: { endAt: { lte: cutoff } },
        },
        include: {
          patient: { select: { fullName: true } },
          slot: true,
        },
        orderBy: { slot: { endAt: "asc" } },
        take: 200,
      }),
      prisma.user.findMany({
        where: {
          role: { in: [$Enums.UserRole.ADMIN, $Enums.UserRole.STAFF] },
          isDeactivated: false,
          email: { not: null },
        },
        select: { email: true, fullName: true },
      }),
    ]);

    const recipients: { email: string; fullName: string }[] = staff
      .filter((user): user is { email: string; fullName: string } =>
        typeof user.email === "string" && user.email.trim().length > 0,
      )
      .map((user) => ({ email: user.email, fullName: user.fullName }));

    // The seeded owner is an ADMIN already in the list; only fall back when
    // there is nobody else to notify.
    if (recipients.length === 0 && config.CLINIC_OWNER_EMAIL !== undefined) {
      recipients.push({
        email: config.CLINIC_OWNER_EMAIL,
        fullName: config.CLINIC_OWNER_NAME ?? "Clinic administrator",
      });
    }
    if (recipients.length === 0) return 0;

    const baseUrl = config.CLIENT_URL.replace(/\/$/, "");
    let sent = 0;

    for (const appt of appointments) {
      const local = slotDateTimeLocal(appt.slot, clinic.timezone);
      const link =
        `${baseUrl}/admin/appointments?scope=needsAttention&date=${encodeURIComponent(local.date)}`;

      for (const recipient of recipients) {
        try {
          const alreadySent = await hasNotification(prisma, {
            type: $Enums.NotificationType.APPOINTMENT_ATTENDANCE_FOLLOW_UP,
            recipient: recipient.email,
            appointmentId: appt.id,
          });
          if (alreadySent) continue;

          const queued = await queueNotification(prisma, {
            type: $Enums.NotificationType.APPOINTMENT_ATTENDANCE_FOLLOW_UP,
            recipient: recipient.email,
            appointmentId: appt.id,
            slotId: appt.slotId,
          });

          dispatchNotificationInBackground(
            queued.id,
            appointmentAttendanceFollowUpEmail({
              fullName: recipient.fullName,
              patientName: appt.patient.fullName,
              doctorName: appt.doctorName,
              slotDate: local.date,
              startTime: local.start,
              endTime: local.end,
              link,
            }),
          );
          sent += 1;
        } catch (err) {
          // A second scheduler tick racing this one hits the partial unique
          // index; that is the idempotency guarantee working, not a failure.
          if (!isUniqueConstraintViolation(err)) {
            logger.error(
              { err, appointmentId: appt.id, recipient: recipient.email },
              "attendance follow-up failed for recipient",
            );
          }
        }
      }
    }

    return sent;
  } catch (err) {
    logger.error({ err }, "attendance follow-up job crashed");
    return 0;
  }
}
