const TOKYO_TZ = "Asia/Tokyo";

export function tokyoDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TOKYO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function maxReservationDate() {
  const [year, month, day] = tokyoDateString().split("-").map(Number);
  const targetMonthIndex = month; // Date.UTC is 0-based, so current 1-based month means +1 month.
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const normalizedMonthIndex = targetMonthIndex % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonthIndex + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDay);
  return new Date(Date.UTC(targetYear, normalizedMonthIndex, clampedDay)).toISOString().slice(0, 10);
}

export function formatTokyoDateTime(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: TOKYO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function shortTime(value: string) {
  return value.slice(0, 5);
}
