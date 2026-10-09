/**
 * The one place a paise integer becomes a currency string, so the public pages
 * and the doctor dashboard cannot disagree about "how much is 5000".
 *
 * `en-IN` digit grouping (12,34,567) is chosen because the clinic's currency is
 * configured per install (the seed ships INR); the grouping is locale, the
 * symbol comes from the currency code the server already sent.
 */
export function formatPaise(paise: number, currency: string): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(paise / 100);
}