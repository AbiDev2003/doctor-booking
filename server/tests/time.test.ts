import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AppError } from "../src/lib/appError.js";
import {
  clinicDayRange,
  localDateTimeToUtc,
  normalizePhoneToE164,
  utcToLocalDateTime,
  formatInClinicTime,
} from "../src/lib/time.js";

// The zone is named explicitly in every test on purpose: time.ts takes
// `timeZone` as a required argument precisely so it never picks one implicitly,
// and a test that relied on `APP_TIMEZONE` would stop testing anything the day
// the clinic's zone changed.
const CLINIC_ZONE = "Asia/Kolkata";
const DST_ZONE = "America/New_York";

/**
 * Asserts the call throws an AppError with the given code.
 *
 * Checking `instanceof AppError` as well as the code is deliberate: it proves
 * the failure came through this app's typed-error path, not incidentally from
 * some unrelated TypeError that happens to have a `code` property.
 */
const throwsCode = (code: string) => (err: unknown): boolean =>
  err instanceof AppError && err.code === code;

describe("localDateTimeToUtc", () => {
  it("converts a clinic-local wall clock to the correct UTC instant", () => {
    // 09:00 in +05:30 is 03:30Z. The half-hour offset is the part a naive
    // implementation gets wrong.
    assert.equal(
      localDateTimeToUtc({ date: "2026-09-30", time: "09:00" }, CLINIC_ZONE).toISOString(),
      "2026-09-30T03:30:00.000Z",
    );
  });

  it("handles midnight as the previous UTC day", () => {
    assert.equal(
      localDateTimeToUtc({ date: "2026-09-30", time: "00:00" }, CLINIC_ZONE).toISOString(),
      "2026-09-29T18:30:00.000Z",
    );
  });

  describe("DST gap (clocks skip forward)", () => {
    // America/New_York springs forward on 2026-03-08, so 02:00–03:00 local
    // never happens. Asia/Kolkata has no DST, so this can only be proven with a
    // zone that does — which is the point: the timezone is configuration.
    it("rejects a local time that does not exist", () => {
      assert.throws(
        () => localDateTimeToUtc({ date: "2026-03-08", time: "02:30" }, DST_ZONE),
        throwsCode("NONEXISTENT_LOCAL_TIME"),
      );
    });

    it("still converts the hours either side of the gap", () => {
      assert.equal(
        localDateTimeToUtc({ date: "2026-03-08", time: "01:30" }, DST_ZONE).toISOString(),
        "2026-03-08T06:30:00.000Z",
      );
      assert.equal(
        localDateTimeToUtc({ date: "2026-03-08", time: "03:30" }, DST_ZONE).toISOString(),
        "2026-03-08T07:30:00.000Z",
      );
    });
  });

  describe("DST fall back (clocks repeat)", () => {
    // 2026-11-01 01:30 local happens twice in New York. §3.2 requires the FIRST
    // occurrence, which is the earlier instant and the conservative choice for
    // "when does this slot end".
    it("takes the first occurrence of an ambiguous local time", () => {
      assert.equal(
        localDateTimeToUtc({ date: "2026-11-01", time: "01:30" }, DST_ZONE).toISOString(),
        "2026-11-01T05:30:00.000Z", // EDT, -04:00
      );
    });

    it("resolves the ambiguous hour earlier than the unambiguous hour after it", () => {
      const ambiguous = localDateTimeToUtc({ date: "2026-11-01", time: "01:30" }, DST_ZONE);
      const unambiguous = localDateTimeToUtc({ date: "2026-11-01", time: "02:30" }, DST_ZONE);
      assert.ok(ambiguous.getTime() < unambiguous.getTime());
    });
  });

  // Date.UTC silently rolls over out-of-range values — month 13 becomes January
  // of the next year, and 2026-02-30 becomes 2 March. A slot that quietly moves
  // date is the same class of bug as one that quietly moves hour, so every one of
  // these must be refused rather than normalised.
  describe("rejects values that would silently roll over", () => {
    it("rejects a day that does not exist in the month", () => {
      assert.throws(
        () => localDateTimeToUtc({ date: "2026-02-30", time: "09:00" }, CLINIC_ZONE),
        throwsCode("INVALID_LOCAL_DATE"),
      );
    });

    it("rejects 29 February in a non-leap year", () => {
      assert.throws(
        () => localDateTimeToUtc({ date: "2027-02-29", time: "09:00" }, CLINIC_ZONE),
        throwsCode("INVALID_LOCAL_DATE"),
      );
    });

    it("accepts 29 February in a leap year", () => {
      assert.equal(
        localDateTimeToUtc({ date: "2028-02-29", time: "09:00" }, CLINIC_ZONE).toISOString(),
        "2028-02-29T03:30:00.000Z",
      );
    });

    it("rejects a month outside 1-12", () => {
      assert.throws(
        () => localDateTimeToUtc({ date: "2026-13-01", time: "09:00" }, CLINIC_ZONE),
        throwsCode("INVALID_LOCAL_DATE"),
      );
    });

    it("rejects hour 24 rather than rolling to the next day", () => {
      assert.throws(
        () => localDateTimeToUtc({ date: "2026-09-30", time: "24:00" }, CLINIC_ZONE),
        throwsCode("INVALID_LOCAL_TIME"),
      );
    });

    it("rejects minute 60 rather than rolling to the next hour", () => {
      assert.throws(
        () => localDateTimeToUtc({ date: "2026-09-30", time: "10:60" }, CLINIC_ZONE),
        throwsCode("INVALID_LOCAL_TIME"),
      );
    });

    it("rejects a non-ISO date format", () => {
      assert.throws(
        () => localDateTimeToUtc({ date: "30-09-2026", time: "09:00" }, CLINIC_ZONE),
        throwsCode("INVALID_LOCAL_DATE"),
      );
    });
  });

  it("rejects a timezone this runtime does not understand", () => {
    // Asserted through the conversion path because the module's public
    // assertValidTimeZone wrapper is dead code; getFormatter is what actually
    // guards this, and it is reached from here.
    assert.throws(
      () => localDateTimeToUtc({ date: "2026-09-30", time: "09:00" }, "Not/AZone"),
      throwsCode("INVALID_TIMEZONE"),
    );
  });
});

describe("utcToLocalDateTime / formatInClinicTime", () => {
  it("is the inverse of localDateTimeToUtc", () => {
    const instant = localDateTimeToUtc({ date: "2026-09-30", time: "09:00" }, CLINIC_ZONE);
    assert.deepEqual(utcToLocalDateTime(instant, CLINIC_ZONE), {
      date: "2026-09-30",
      time: "09:00:00",
    });
  });

  it("formats an instant in clinic-local time", () => {
    assert.equal(
      formatInClinicTime(new Date("2026-09-30T03:30:00Z"), CLINIC_ZONE),
      "2026-09-30 09:00:00",
    );
  });

  it("round-trips midnight without reporting hour 24", () => {
    // Intl can render midnight as hour 24 under some hour cycles. Asserted
    // because a "24:00:00" in a confirmation email is a visible bug.
    const local = utcToLocalDateTime(new Date("2026-09-29T18:30:00Z"), CLINIC_ZONE);
    assert.equal(local.time, "00:00:00");
  });

  it("rejects a bad timezone on the read path too", () => {
    assert.throws(
      () => formatInClinicTime(new Date(), "Not/AZone"),
      throwsCode("INVALID_TIMEZONE"),
    );
  });
});

describe("normalizePhoneToE164", () => {
  it("normalises every spelling of one number to one identity key", () => {
    // This is the property that matters: §16's desk create-or-find-by-phone
    // depends on one person never being two rows under two spellings.
    const spellings = ["+919876543210", "00919876543210", "09876543210", "9876543210", "+91 98765 43210"];
    const normalised = new Set(spellings.map((value) => normalizePhoneToE164(value)));
    assert.equal(normalised.size, 1, "all spellings must collapse to a single key");
    assert.equal([...normalised][0], "+919876543210");
  });

  it("strips the punctuation people actually type", () => {
    assert.equal(normalizePhoneToE164("(98765) 43210"), "+919876543210");
    assert.equal(normalizePhoneToE164("98765-43210"), "+919876543210");
    assert.equal(normalizePhoneToE164("+91-98765-43210"), "+919876543210");
  });

  it("treats a bare country-code prefix as national, not international", () => {
    // `91-98765-43210` is genuinely ambiguous. Only `+` and `00` mark an
    // international number, and guessing which was meant is how one person
    // becomes two rows — so the deterministic reading wins.
    assert.equal(normalizePhoneToE164("91-98765-43210"), "+91919876543210");
  });

  it("accepts an explicit country code override", () => {
    assert.equal(normalizePhoneToE164("02012345678", "44"), "+442012345678");
  });

  it("rejects input that is not a phone number", () => {
    assert.throws(() => normalizePhoneToE164("98765abc210"), throwsCode("INVALID_PHONE"));
    assert.throws(() => normalizePhoneToE164("   "), throwsCode("INVALID_PHONE"));
  });

  it("rejects a length outside the E.164 bounds", () => {
    assert.throws(() => normalizePhoneToE164("12345"), throwsCode("INVALID_PHONE"));
    assert.throws(() => normalizePhoneToE164("+9198765432109876543"), throwsCode("INVALID_PHONE"));
  });
});

describe("clinicDayRange", () => {
  it("bounds the clinic-local day in UTC instants", () => {
    // 2026-10-01 03:30Z is 09:00 the same morning in +05:30, so the clinic
    // day 2026-10-01 runs from its local midnight — which in +05:30 is the
    // PREVIOUS UTC date's 18:30Z — to the exclusive local midnight a day on.
    const range = clinicDayRange(new Date("2026-10-01T03:30:00Z"), CLINIC_ZONE);
    assert.equal(range.start.toISOString(), "2026-09-30T18:30:00.000Z");
    assert.equal(range.endExclusive.toISOString(), "2026-10-01T18:30:00.000Z");
  });

  it("maps a UTC instant whose clinic-local date differs to the local day", () => {
    // 23:00Z is 04:30 the NEXT morning in +05:30: still the same clinic day
    // window, whose bounds sit a UTC date in the past.
    const range = clinicDayRange(new Date("2026-10-01T23:00:00Z"), CLINIC_ZONE);
    assert.equal(range.start.toISOString(), "2026-10-01T18:30:00.000Z");
    assert.equal(range.endExclusive.toISOString(), "2026-10-02T18:30:00.000Z");
  });

  it("minus-offset zones start their day on the previous UTC date", () => {
    const range = clinicDayRange(new Date("2026-10-02T04:00:00Z"), DST_ZONE); // 00:00 EDT
    assert.equal(range.start.toISOString(), "2026-10-02T04:00:00.000Z");
  });

  it("rolls cleanly across a month boundary", () => {
    // 2026-10-31 23:30 local (+0530) is 2026-10-31T18:00Z. The start must be
    // the 30th's 18:30Z and the exclusive end the 31st's 18:30Z — nothing may
    // slip back to the 30th (out ahead of midnight) or forward past midnight.
    const range = clinicDayRange(new Date("2026-10-31T18:00:00Z"), CLINIC_ZONE);
    assert.equal(range.start.toISOString(), "2026-10-30T18:30:00.000Z");
    assert.equal(range.endExclusive.toISOString(), "2026-10-31T18:30:00.000Z");
  });

  it("keeps a DST-sprung-forward day 23 hours long and correctly bounded", () => {
    // 2026-03-08 11:00 EDT — the day DST began in New York. The day window is
    // 23 real hours; the start must still be its local midnight and the end
    // the following local midnight, not ±24h from now.
    const spring = clinicDayRange(new Date("2026-03-08T15:00:00Z"), DST_ZONE); // 11:00 EDT
    assert.equal(spring.start.toISOString(), "2026-03-08T05:00:00.000Z"); // 00:00 EST
    assert.equal(spring.endExclusive.toISOString(), "2026-03-09T04:00:00.000Z"); // 00:00 EDT
  });

  it("keeps a DST-fallback day 25 hours long and correctly bounded", () => {
    // 2026-11-01 12:00 EST — the day DST ended in New York. The window must
    // cover 25 real hours without inventing a second day or skipping the
    // repeated hour: 00:00 EDT (04:00Z) → 00:00 EST the following day (05:00Z).
    const fall = clinicDayRange(new Date("2026-11-01T17:00:00Z"), DST_ZONE); // 12:00 EST
    assert.equal(fall.start.toISOString(), "2026-11-01T04:00:00.000Z"); // 00:00 EDT
    assert.equal(fall.endExclusive.toISOString(), "2026-11-02T05:00:00.000Z"); // 00:00 EST
  });
});
