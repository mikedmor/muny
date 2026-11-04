/** Today's date in the server's time zone (the TZ env var), as YYYY-MM-DD. */
export const localToday = () => new Date().toLocaleDateString("en-CA");
