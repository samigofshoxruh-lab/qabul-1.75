import type { Lesson } from "./types";

/** Повторяющийся урок это одна запись: дни недели и дата окончания. Дни недели считаются по ISO: понедельник 1, воскресенье 7. */
export const WEEKDAYS: { id: number; short: string; long: string }[] = [
  { id: 1, short: "Пн", long: "понедельник" },
  { id: 2, short: "Вт", long: "вторник" },
  { id: 3, short: "Ср", long: "среда" },
  { id: 4, short: "Чт", long: "четверг" },
  { id: 5, short: "Пт", long: "пятница" },
  { id: 6, short: "Сб", long: "суббота" },
  { id: 7, short: "Вс", long: "воскресенье" },
];

type Repeating = Pick<Lesson, "starts_at" | "repeat_days" | "repeat_until">;

export const isRecurring = (l: Pick<Lesson, "repeat_days">) => (l.repeat_days?.length ?? 0) > 0;
export const isoDay = (d: Date) => (d.getDay() === 0 ? 7 : d.getDay());

const pad = (n: number) => String(n).padStart(2, "0");
/** Дата «ГГГГ-ММ-ДД» в часовом поясе пользователя. */
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const startOfDay = (d: Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

/** Занятия урока в промежутке. Обычный урок даёт одно занятие, повторяющийся по одному на каждый нужный день. */
export function occurrencesBetween(l: Repeating, from: Date, to: Date): Date[] {
  if (!l.starts_at) return [];
  const start = new Date(l.starts_at);
  if (!isRecurring(l)) return start >= from && start <= to ? [start] : [];
  const until = l.repeat_until ? new Date(`${l.repeat_until}T23:59:59`) : null;
  const result: Date[] = [];
  const cursor = startOfDay(new Date(Math.max(startOfDay(start).getTime(), startOfDay(from).getTime())));
  while (cursor <= to && (!until || cursor <= until) && result.length < 500) {
    if (l.repeat_days.includes(isoDay(cursor))) {
      const at = new Date(cursor);
      at.setHours(start.getHours(), start.getMinutes(), 0, 0);
      if (at >= start && at >= from && at <= to) result.push(at);
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}

/** Ближайшее занятие. Закончившийся повторяющийся урок: null. */
export function nextStart(l: Repeating, from = new Date()): Date | null {
  if (!l.starts_at) return null;
  if (!isRecurring(l)) return new Date(l.starts_at);
  const far = new Date(from);
  far.setFullYear(far.getFullYear() + 1);
  return occurrencesBetween(l, from, far)[0] ?? null;
}

/** «Пн, Ср, Пт в 07:14, до 31 мая 2027» */
export function repeatSummary(l: Repeating): string {
  const days = WEEKDAYS.filter((d) => l.repeat_days.includes(d.id)).map((d) => d.short).join(", ");
  const time = l.starts_at ? new Date(l.starts_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "";
  const until = l.repeat_until ? new Date(`${l.repeat_until}T12:00:00`).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }) : "без даты окончания";
  return `${days}${time ? ` в ${time}` : ""}, ${l.repeat_until ? `до ${until}` : until}`;
}

/** Понедельник недели, в которую попадает дата. */
export function weekStart(date: Date): Date {
  const d = startOfDay(date);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}
