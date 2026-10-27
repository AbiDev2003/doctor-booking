import { $Enums } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/appError.js";
import { logger } from "../lib/logger.js";
import { getClinicSettings } from "../services/clinic.service.js";
import { queueNotification } from "../services/notifications/notification.service.js";
import { dispatchNotificationInBackground } from "../services/notifications/notification.service.js";
import { appointmentReminderEmail } from "../lib/emailTemplates.js";
import { utcToLocalDateTime } from "../lib/time.js";

function slotDateTimeLocal(slot: { slotDate: Date; startTime: Date; endTime: Date }, timezone: string) {
  const localDate = utcToLocalDateTime(new Date(slot.slotDate.getTime()), timezone).date;
  const start = slot.startTime.toISOString().slice(11, 16);
  const end = slot.endTime.toISOString().slice(11, 16);
  return { date: localDate, start, end };
}

export async function sendAppointmentReminders(now: Date): Promise<number> {
  try {
    const clinic = await getClinicSettings();
    const leadMinutes = clinic.reminderLeadMinutes ?? 120;
    const windowStart = new Date(now.getTime() + leadMinutes * 60 * 1000 - 2 * 60 * 1000);
    const windowEnd = new Date(now.getTime() + leadMinutes * 60 * 1000 + 2 * 60 * 1000);

    const appointments = await prisma.appointment.findMany({
      where: {
        status: $Enums.AppointmentStatus.CONFIRMED,
        patient: { email: { not: null } },
        slot: {
          startAt: {
            gte: windowStart,
            lte: windowEnd,
          },
        },
      },
      include: {
        patient: { select: { email: true, fullName: true } },
        slot: true,
        doctor: { select: { fullName: true } },
      },
    });

    let sent = 0;
    for (const appt of appointments) {
      try {
        if (!appt.patient.email) continue;
        const existing = await prisma.notification.findFirst({
          where: {
            appointmentId: appt.id,
            type: $Enums.NotificationType.APPOINTMENT_REMINDER,
          },
        });
        if (existing) continue;

        const res = await queueNotification(prisma, {
          type: $Enums.NotificationType.APPOINTMENT_REMINDER,
          recipient: appt.patient.email,
          appointmentId: appt.id,
          slotId: appt.slotId,
        });

        const local = slotDateTimeLocal(appt.slot, clinic.timezone);
        const content = appointmentReminderEmail({
          fullName: appt.patient.fullName,
          appointmentId: appt.id,
          doctorName: appt.doctorName ?? appt.doctor?.fullName,
          slotDate: local.date,
          startTime: local.start,
          endTime: local.end,
        });

        dispatchNotificationInBackground(res.id, content);
        sent += 1;
      } catch (err) {
        logger.error({ err, appointmentId: appt.id }, "appointment reminder job failed for appointment");
      }
    }
    return sent;
  } catch (err) {
    logger.error({ err }, "appointment reminder job crashed");
    return 0;
  }
}
