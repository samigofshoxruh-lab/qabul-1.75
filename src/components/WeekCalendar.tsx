import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { weekStart, WEEKDAYS } from "../lib/recurrence";
import type { Lesson } from "../lib/types";

const time = (iso: string) => new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
const dayLabel = (d: Date) => d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });

/** Неделя с понедельника: уроки по дням, отменённые зачёркнуты. */
export function WeekCalendar({ lessons, selectedId, onOpen }: { lessons: Lesson[]; selectedId?: string; onOpen: (id: string) => void }) {
  const [start, setStart] = useState(() => weekStart(new Date()));

  const days = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const date = new Date(start);
        date.setDate(start.getDate() + i);
        const items = lessons
          .filter((l) => l.starts_at && new Date(l.starts_at).toDateString() === date.toDateString())
          .sort((a, b) => new Date(a.starts_at!).getTime() - new Date(b.starts_at!).getTime());
        return { date, items };
      }),
    [lessons, start],
  );

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
              {WEEKDAYS.find((d) => d.id === date.getDay())!.short}, {dayLabel(date)}
            </h3>
            {items.length === 0 && <p className="muted week-empty">Нет уроков</p>}
            {items.map((lesson) => (
              <button
                type="button"
                key={lesson.id}
                className={`week-lesson ${lesson.id === selectedId ? "is-selected" : ""} ${lesson.cancelled_at ? "is-cancelled" : ""}`}
                onClick={() => onOpen(lesson.id)}
              >
                <span className="week-time">{time(lesson.starts_at!)}</span>
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
