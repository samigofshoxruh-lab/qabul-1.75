import { useEffect, useState } from "react";
import { supabase } from "./supabase";

const KEY = "qabul-lead-sound";

export function soundEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSoundEnabled(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Без хранилища звук просто остаётся включённым.
  }
}

/** Два коротких тона. Браузер разрешает звук после любого клика по сайту. */
export function beep() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + i * 0.18 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.18);
      osc.stop(ctx.currentTime + i * 0.18 + 0.17);
    });
    setTimeout(() => ctx.close(), 800);
  } catch {
    // Нет звука, остаётся счётчик в заголовке вкладки.
  }
}

/** Звук и уведомление о новой заявке, пока сайт открыт. Включается кнопкой в списке заявок. */
export function useNewLeadAlert(workspaceId: string) {
  useEffect(() => {
    const live = supabase
      .channel(`lead-alert-${workspaceId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "leads", filter: `workspace_id=eq.${workspaceId}` }, () => {
        if (!soundEnabled()) return;
        beep();
        if ("Notification" in window && Notification.permission === "granted" && document.visibilityState !== "visible") {
          new Notification("Новая заявка", { body: "В Qabul появилась новая заявка." });
        }
      })
      .subscribe();
    return () => {
      supabase.removeChannel(live);
    };
  }, [workspaceId]);
}

export function useSoundSetting(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(soundEnabled());
  return [
    on,
    (next) => {
      setSoundEnabled(next);
      setOn(next);
      if (next && "Notification" in window && Notification.permission === "default") Notification.requestPermission();
    },
  ];
}
