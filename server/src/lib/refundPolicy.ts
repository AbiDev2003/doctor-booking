import { $Enums } from "../generated/prisma/client.js";

export interface ExistingRefund {
  readonly amountPaise: number;
}

export function remainingRefundablePaise(amountPaise: number, existing: readonly ExistingRefund[]): number {
  const committed = existing.reduce((sum, refund) => sum + refund.amountPaise, 0);
  return Math.max(0, amountPaise - committed);
}

export function cancellationRefundKind(input: {
  readonly actorRole: $Enums.UserRole;
  readonly clinicCaused: boolean;
}): $Enums.RefundKind {
  if (input.actorRole !== $Enums.UserRole.PATIENT || input.clinicCaused) {
    return $Enums.RefundKind.CLINIC_CAUSED;
  }
  return $Enums.RefundKind.CANCELLATION;
}

const CONVERSION_FAILURE_KINDS: Readonly<Record<string, $Enums.RefundKind>> = {
  ALREADY_BOOKED: $Enums.RefundKind.CONVERSION_FAILED,
  CONVERSION_FAILED: $Enums.RefundKind.CONVERSION_FAILED,
  CONVERSION_STATE_INVALID: $Enums.RefundKind.CONVERSION_FAILED,
  DOCTOR_UNAVAILABLE: $Enums.RefundKind.CONVERSION_FAILED,
  HOLD_EXPIRED: $Enums.RefundKind.EXPIRED_HOLD,
  HOLD_NOT_FOUND: $Enums.RefundKind.CONVERSION_FAILED,
  HOLD_RELEASED: $Enums.RefundKind.CONVERSION_FAILED,
  PAYMENT_NOT_PENDING: $Enums.RefundKind.CONVERSION_FAILED,
  SLOT_DISABLED: $Enums.RefundKind.CONVERSION_FAILED,
  SLOT_FULL: $Enums.RefundKind.CONVERSION_FAILED,
};

export function conversionFailureRefundKind(code: string): $Enums.RefundKind | null {
  return CONVERSION_FAILURE_KINDS[code] ?? null;
}

export function conversionFailureReleaseReason(
  kind: $Enums.RefundKind,
): $Enums.SeatHoldReleaseReason {
  return kind === $Enums.RefundKind.EXPIRED_HOLD
    ? $Enums.SeatHoldReleaseReason.EXPIRED
    : $Enums.SeatHoldReleaseReason.CONVERSION_FAILED;
}

export function refundNotificationType(kind: $Enums.RefundKind): $Enums.NotificationType {
  return kind === $Enums.RefundKind.EXPIRED_HOLD
    ? $Enums.NotificationType.PAYMENT_LATE_REFUND
    : $Enums.NotificationType.REFUND_COMPLETED;
}
