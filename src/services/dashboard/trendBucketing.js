// services/dashboard/trendBucketing.js
//
// UTC-based bucketing shared by the Dashboard's Revenue Trend chart
// (getDashboard.controller.js's getRevenueTrend) and its drill-down
// (getRevenueTrendDetail.controller.js) - kept in exactly one place so
// the drill-down can never disagree with which bucket a clicked point
// actually covers. Deliberately UTC (toISOString-based), matching the
// rest of the legacy Dashboard's date handling - NOT the newer
// Business Analytics module's local-time convention (see
// services/analytics/analyticsDateUtils.js), which is a different,
// intentionally-diverging module built later specifically to avoid
// this same local/UTC mismatch class.

export const TREND_RANGE_CONFIG = {
  today: { days: 0, granularity: "hour" },
  "7d": { days: 7, granularity: "day" },
  "30d": { days: 30, granularity: "day" },
  "3m": { days: 90, granularity: "week" },
  "6m": { days: 180, granularity: "week" },
  "1y": { days: 365, granularity: "month" },
};

export const getTrendStart = (range) => {
  const config = TREND_RANGE_CONFIG[range] || TREND_RANGE_CONFIG["30d"];
  const start = new Date();
  if (config.days === 0) {
    start.setHours(0, 0, 0, 0);
  } else {
    start.setDate(start.getDate() - config.days);
  }
  return { start, granularity: config.granularity };
};

export const hourKey = (d) => new Date(d).toISOString().slice(0, 13) + ":00";
export const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
export const weekKey = (d) => {
  const date = new Date(d);
  const firstDayOfWeek = new Date(date);
  firstDayOfWeek.setDate(date.getDate() - date.getDay());
  return firstDayOfWeek.toISOString().slice(0, 10);
};
export const monthKey = (d) => new Date(d).toISOString().slice(0, 7);

export const keyFnFor = (granularity) =>
  granularity === "hour" ? hourKey : granularity === "day" ? dayKey : granularity === "week" ? weekKey : monthKey;

// Inverse of keyFnFor - given a bucket's granularity and the key string
// it produced (e.g. "2026-09-19T14:00", "2026-09-19", "2026-09"),
// returns the [start, end) UTC window that bucket covers. Used only by
// the drill-down, to re-fetch exactly the documents that fed that one
// point - never a re-derived approximation.
export const resolveBucketRange = (granularity, key) => {
  if (granularity === "hour") {
    const start = new Date(`${key}:00.000Z`);
    const end = new Date(start);
    end.setUTCHours(end.getUTCHours() + 1);
    return { start, end };
  }
  if (granularity === "week") {
    const start = new Date(`${key}T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);
    return { start, end };
  }
  if (granularity === "month") {
    const start = new Date(`${key}-01T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    return { start, end };
  }
  // "day" (default)
  const start = new Date(`${key}T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
};
