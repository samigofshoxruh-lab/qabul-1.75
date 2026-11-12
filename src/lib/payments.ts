import type { PaymentMethod } from "./types";

/** Payme и Click здесь только пометка для бухгалтерии: Qabul к ним не подключён. */
export const METHODS: { id: PaymentMethod; label: string }[] = [
  { id: "cash", label: "Наличные" },
  { id: "card", label: "Карта" },
  { id: "payme", label: "Payme" },
  { id: "click", label: "Click" },
  { id: "transfer", label: "Перевод" },
  { id: "other", label: "Другое" },
];

export const METHOD_LABEL = Object.fromEntries(METHODS.map((m) => [m.id, m.label])) as Record<PaymentMethod, string>;

/** Значение для поля «datetime-local» в часовом поясе пользователя. */
export function nowLocalInput(date = new Date()): string {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

/** Начало и конец месяца «ГГГГ-ММ» в часовом поясе пользователя, как ISO для запроса. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  return { from: new Date(y, m - 1, 1).toISOString(), to: new Date(y, m, 1).toISOString() };
}
