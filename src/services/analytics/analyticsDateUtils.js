// services/analytics/analyticsDateUtils.js
//
// Local-time boundaries for the Business Analytics module - deliberately
// diverges from the legacy Dashboard/P&L mix of local-time window
// boundaries + UTC $dateToString trend buckets (see
// shopping-frontend/docs/COMPLETE-ANALYTICS-IMPLEMENTATION-LOGIC.md §0.6).
// Every Analytics date boundary AND every trend bucket key uses the
// server's local time consistently, so a "this month" filter can never
// disagree with its own trend chart the way two legacy functions can.

export const startOfLocalDay = (d = new Date()) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

export const endOfLocalDay = (d = new Date()) => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};

// Parses a "YYYY-MM-DD" query param as a LOCAL calendar day - not UTC
// midnight, which `new Date("YYYY-MM-DD")` would give, which is off by
// a day in every timezone behind UTC.
export const parseLocalDate = (value, endOfDay = false) => {
  if (!value) return null;
  const [y, m, d] = String(value).split("-").map(Number);
  if (!y || !m || !d) return null;
  return endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d, 0, 0, 0, 0);
};

export const defaultMonthRange = () => {
  const now = new Date();
  return {
    start: new Date(now.getFullYear(), now.getMonth(), 1),
    end: endOfLocalDay(now),
  };
};

export const localDayKey = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};

export const localWeekKey = (d) => {
  const x = new Date(d);
  x.setDate(x.getDate() - x.getDay()); // back to Sunday, local time
  return localDayKey(x);
};

export const localMonthKey = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`;
};

export const localBucketKeyFor = (granularity) =>
  granularity === "week" ? localWeekKey : granularity === "month" ? localMonthKey : localDayKey;
