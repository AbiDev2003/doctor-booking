import { $Enums } from "../generated/prisma/client.js";
import type { DeskAppointmentActions, DeskPaymentSummary } from "../schemas/staff.js";

/**
 * The one source of truth for "which attendance verbs are open right now".
 *
 * Both the staff day board and the admin appointment list render the same
 * buttons from these flags. They are pure: the caller supplies the loaded row
 * and the current instant, so no service has a private dialect of the rules.
 */
export interface ActionFlagsAppointment {
  readonly status: $Enums.AppointmentStatus;
  readonly slot: { readonly startAt: Date; readonly endAt: Date };
  readonly payments: readonly {
    readonly amountPaise: number;
    readonly status: $Enums.PaymentStatus;
    readonly method: $Enums.PaymentMethod | null;
    readonly createdAt: Date;
  }[];
}

function statusLabel(status: $Enums.AppointmentStatus): string {
  return status
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function paymentSummaryFor(appointment: ActionFlagsAppointment): DeskPaymentSummary {
  let outstandingPaise = 0;
  let paidPaise = 0;
  let method: $Enums.PaymentMethod | null = null;

  for (const payment of appointment.payments) {
    if (payment.status === $Enums.PaymentStatus.PENDING) {
      outstandingPaise += payment.amountPaise;
    } else if (payment.status === $Enums.PaymentStatus.PAID) {
      paidPaise += payment.amountPaise;
      method ??= payment.method;
    }
  }

  return {
    status: outstandingPaise > 0 ? "PENDING" : paidPaise > 0 ? "PAID" : "NONE",
    outstandingPaise,
    paidPaise,
    method,
  };
}

/**
 * Mirrors the transition services: `canComplete` includes the §13.1 pending-
 * payment wall, and no-show is only available after the slot has ended.
 */
export function appointmentActionFlags(
  appointment: ActionFlagsAppointment,
  now: Date,
  payment: DeskPaymentSummary,
): DeskAppointmentActions {
  const status = appointment.status;
  const { startAt, endAt } = appointment.slot;
  const label = statusLabel(status);

  const canArrive = status === $Enums.AppointmentStatus.CONFIRMED && now.getTime() >= startAt.getTime();
  const canComplete = status === $Enums.AppointmentStatus.ARRIVED && payment.outstandingPaise === 0;
  const canNoShow =
    status === $Enums.AppointmentStatus.CONFIRMED &&
    now.getTime() >= endAt.getTime() &&
    payment.outstandingPaise === 0;
  const canReject = status === $Enums.AppointmentStatus.CONFIRMED;
  const canCancel =
    status === $Enums.AppointmentStatus.CONFIRMED || status === $Enums.AppointmentStatus.ARRIVED;
  const canReschedule = status === $Enums.AppointmentStatus.CONFIRMED;

  return {
    canArrive,
    canComplete,
    canNoShow,
    canReject,
    canCancel,
    canReschedule,
    arriveBlockedReason: canArrive
      ? null
      : status !== $Enums.AppointmentStatus.CONFIRMED
        ? `Only a confirmed booking can be checked in (this one is ${label.toLowerCase()}).`
        : "Check-in opens when the slot starts.",
    completeBlockedReason: canComplete
      ? null
      : status !== $Enums.AppointmentStatus.ARRIVED
        ? `Only an arrived booking can be completed (this one is ${label.toLowerCase()}).`
        : "Collect or void the pending payment before completing the visit.",
    noShowBlockedReason: canNoShow
      ? null
      : status !== $Enums.AppointmentStatus.CONFIRMED
        ? `Only a confirmed booking can be marked no-show (this one is ${label.toLowerCase()}).`
        : now.getTime() < endAt.getTime()
          ? "No-show can be recorded after the slot ends."
          : "Collect or void the pending payment before closing the visit.",
    cancelBlockedReason: canCancel ? null : `This booking is already ${label.toLowerCase()}.`,
    rescheduleBlockedReason: canReschedule
      ? null
      : `Only a confirmed booking can be rescheduled (this one is ${label.toLowerCase()}).`,
  };
}
