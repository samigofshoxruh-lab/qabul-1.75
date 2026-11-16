import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { isoDay, occurrencesBetween, weekStart, WEEKDAYS } from "../lib/recurrence";
import type { Lesson } from "../lib/types";

const time = (iso: string) => new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
const dayLabel = (d: Date) => d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });

/** Неделя с понедельника: уроки по дням, отменённые зачёркнуты. */
export function WeekCalendar({ lessons, selectedId, onOpen }: { lessons: Lesson[]; selectedId?: string; onOpen: (id: string) => void }) {
  const [start, setStart] = useState(() => weekStart(new Date()));

  const days = useMemo(() => {
    const weekEnd = new Date(start);
    weekEnd.setDate(start.getDate() + 7);
    // Повторяющийся урок раскладывается по дням недели, хотя в базе это одна запись.
    const all = lessons.flatMap((lesson) => occurrencesBetween(lesson, start, weekEnd).map((at) => ({ lesson, at })));
    return Array.from({ length: 7 }, (_, i) => {
      const date = new Date(start);
      date.setDate(start.getDate() + i);
      const items = all.filter((x) => x.at.toDateString() === date.toDateString()).sort((a, b) => a.at.getTime() - b.at.getTime());
      return { date, items };
    });
  }, [lessons, start]);

  const shift = (weeks: number) =>
    setStart((current) => {
      const next = new Date(current);
      next.setDate(current.getDate() + weeks * 7);
      return next;
    });

  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const today = new Date().toDateString();

  return (
    <section className="week" aria-label="Неделя">
      <div className="week-nav">
        <button type="button" className="icon-button" onClick={() => shift(-1)} aria-label="Прошлая неделя">
          <ChevronLeft size={18} aria-hidden />
        </button>
        <strong>{dayLabel(start)} – {dayLabel(end)}</strong>
        <button type="button" className="icon-button" onClick={() => shift(1)} aria-label="Следующая неделя">
          <ChevronRight size={18} aria-hidden />
        </button>
        <button type="button" className="link-button" onClick={() => setStart(weekStart(new Date()))}>Сегодня</button>
      </div>
      <div className="week-grid">
        {days.map(({ date, items }) => (
          <div className={`week-day ${date.toDateString() === today ? "is-today" : ""}`} key={date.toISOString()}>
            <h3>
              {WEEKDAYS.find((d) => d.id === isoDay(date))!.short}, {dayLabel(date)}
            </h3>
            {items.length === 0 && <p className="muted week-empty">Нет уроков</p>}
            {items.map(({ lesson, at }) => (
              <button
                type="button"
                key={`${lesson.id}-${at.toISOString()}`}
                className={`week-lesson ${lesson.id === selectedId ? "is-selected" : ""} ${lesson.cancelled_at ? "is-cancelled" : ""}`}
                onClick={() => onOpen(lesson.id)}
              >
                <span className="week-time">{time(at.toISOString())}</span>
                <span className="week-title">{lesson.title}</span>
                {(lesson.teacher || lesson.room) && <span className="muted">{[lesson.teacher, lesson.room].filter(Boolean).join(", ")}</span>}
                {lesson.cancelled_at && <span className="chip chip-bad">Отменён</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
