/** Повторяющиеся уроки: каждый выбранный день недели от даты начала до даты окончания, в то же время. */
export const WEEKDAYS: { id: number; short: string; long: string }[] = [
  { id: 1, short: "Пн", long: "понедельник" },
  { id: 2, short: "Вт", long: "вторник" },
  { id: 3, short: "Ср", long: "среда" },
  { id: 4, short: "Чт", long: "четверг" },
  { id: 5, short: "Пт", long: "пятница" },
  { id: 6, short: "Сб", long: "суббота" },
  { id: 0, short: "Вс", long: "воскресенье" },
];

export const MAX_SERIES = 60;

/** startLocal: «ГГГГ-ММ-ДДTЧЧ:ММ», untilDate: «ГГГГ-ММ-ДД», weekdays: 0 это воскресенье, как в JS. */
export function expandWeekly(startLocal: string, weekdays: number[], untilDate: string): Date[] {
  const start = new Date(startLocal);
  if (Number.isNaN(start.getTime()) || !untilDate || weekdays.length === 0) return [];
  const until = new Date(`${untilDate}T23:59:59`);
  const result: Date[] = [];
  const cursor = new Date(start);
  while (cursor <= until && result.length < MAX_SERIES + 1) {
    if (weekdays.includes(cursor.getDay())) result.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}

/** Понедельник недели, в которую попадает дата. */
export function weekStart(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}
