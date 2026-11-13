import { createContext, useContext } from "react";

export interface PlatformPerms {
  role: "main" | "manager" | "support" | "custom";
  can_manage_companies: boolean;
  can_manage_access: boolean;
  can_manage_users: boolean;
  can_support: boolean;
  can_manage_admins: boolean;
}

const NONE: PlatformPerms = {
  role: "support",
  can_manage_companies: false,
  can_manage_access: false,
  can_manage_users: false,
  can_support: false,
  can_manage_admins: false,
};

export const PlatformPermsContext = createContext<PlatformPerms>(NONE);
export const usePlatformPerms = () => useContext(PlatformPermsContext);

export const PERM_LABELS: { key: keyof Omit<PlatformPerms, "role">; label: string; hint: string }[] = [
  { key: "can_manage_companies", label: "Компании", hint: "создавать, переименовывать, приостанавливать и удалять компании" },
  { key: "can_manage_access", label: "Сроки доступа", hint: "продлевать доступ компаниям и менять личные сроки" },
  { key: "can_manage_users", label: "Пользователи компаний", hint: "добавлять, удалять и менять пароли владельцам и администраторам компаний" },
  { key: "can_support", label: "Поддержка", hint: "читать и отвечать в чате поддержки, шаблоны ответов" },
  { key: "can_manage_admins", label: "Админы платформы", hint: "добавлять админов и выдавать им права" },
];

export const ROLE_LABEL: Record<PlatformPerms["role"], string> = {
  main: "Главный админ (все права)",
  manager: "Менеджер (компании, сроки, пользователи, поддержка)",
  support: "Поддержка (только чат)",
  custom: "Свои права (отметить вручную)",
};

export const ROLE_PRESETS: Record<Exclude<PlatformPerms["role"], "custom">, Omit<PlatformPerms, "role">> = {
  main: { can_manage_companies: true, can_manage_access: true, can_manage_users: true, can_support: true, can_manage_admins: true },
  manager: { can_manage_companies: true, can_manage_access: true, can_manage_users: true, can_support: true, can_manage_admins: false },
  support: { can_manage_companies: false, can_manage_access: false, can_manage_users: false, can_support: true, can_manage_admins: false },
};
