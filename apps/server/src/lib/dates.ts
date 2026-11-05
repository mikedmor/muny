/** A date in the server's time zone (the TZ env var), as YYYY-MM-DD. Defaults to now. */
export const localToday = (at: Date = new Date()) => at.toLocaleDateString("en-CA");
