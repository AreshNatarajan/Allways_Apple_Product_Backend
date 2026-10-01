// Daily forced logout: every session issued before the most recent
// 8:30 PM IST is dead. Stateless - computed from the token's own `iat`,
// so it needs no cron job and survives server restarts. IST has no DST,
// so a fixed +05:30 offset is exact year-round.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const CUTOFF_HOUR_IST = 20;
const CUTOFF_MINUTE_IST = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// Most recent 8:30 PM IST at or before `now`.
export const getLatestSessionCutoff = (now = new Date()) => {
    // Shift into IST wall-clock time, then read it back with UTC getters.
    const ist = new Date(now.getTime() + IST_OFFSET_MS);
    const todaysCutoffUtcMs =
        Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), CUTOFF_HOUR_IST, CUTOFF_MINUTE_IST) - IST_OFFSET_MS;
    return new Date(todaysCutoffUtcMs <= now.getTime() ? todaysCutoffUtcMs : todaysCutoffUtcMs - DAY_MS);
};

// `iat` is the JWT issued-at claim, in seconds.
export const isPastSessionCutoff = (iat, now = new Date()) =>
    !iat || iat * 1000 < getLatestSessionCutoff(now).getTime();

export const SESSION_CUTOFF_MESSAGE = "Session ended by the daily 8:30 PM auto-logout. Please log in again.";
