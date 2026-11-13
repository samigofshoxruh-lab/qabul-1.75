export type Platform = "telegram" | "instagram" | "facebook" | "whatsapp" | "viber" | "vk";
export type LeadStatus = "collecting" | "new" | "in_work" | "done" | "rejected";
export type QuestionType = "choice" | "text" | "phone";

export interface Option {
  id: string;
  label: string;
  label_uz?: string;
}

export interface Workspace {
  id: string;
  name: string;
  role: "owner" | "admin";
  access_until: string | null;
  can_view_payments: boolean;
  can_edit_survey: boolean;
}

export interface Membership {
  workspace_id: string;
  name: string;
  role: "owner" | "admin";
  access_until: string | null;
  is_suspended: boolean;
  active: boolean;
  can_view_payments: boolean;
  can_edit_survey: boolean;
}

export interface Access {
  is_platform_admin: boolean;
  platform: import("./platformPerms").PlatformPerms | null;
  memberships: Membership[];
}

export interface CompanyMember {
  user_id: string;
  email: string | null;
  role: "owner" | "admin";
  access_until: string | null;
  created_at: string;
}

export interface Company {
  id: string;
  name: string;
  access_until: string | null;
  is_suspended: boolean;
  created_at: string;
  members: CompanyMember[];
  channels: Platform[];
  leads_count: number;
}

export interface Lesson {
  id: string;
  workspace_id: string;
  title: string;
  starts_at: string | null;
  duration_minutes: number | null;
  notes: string | null;
  price: number;
  remind: boolean;
  teacher: string | null;
  room: string | null;
  series_id: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  lesson_students?: { count: number }[];
}

export interface LessonStudent {
  id: string;
  lesson_id: string;
  contact_id: string | null;
  name: string;
  phone: string | null;
  note: string | null;
  attended: boolean | null;
  price: number;
  discount: number;
  paid: number;
  debt: number;
}

export type PaymentMethod = "cash" | "card" | "payme" | "click" | "transfer" | "other";

export interface Payment {
  id: string;
  workspace_id: string;
  student_id: string;
  amount: number;
  method: PaymentMethod;
  note: string | null;
  paid_at: string;
  created_by: string | null;
  created_at: string;
}

export interface LessonReminder {
  student_id: string;
  kind: "day" | "hour";
  starts_at: string;
  error: string | null;
  messages: { status: Message["status"]; error: string | null } | null;
}

export interface QuickReply {
  id: string;
  workspace_id: string;
  title: string;
  text: string;
}

export interface Member {
  user_id: string;
  email: string | null;
  role: "owner" | "admin";
  created_at: string;
  can_view_payments: boolean;
  can_edit_survey: boolean;
}

export interface Survey {
  id: string;
  workspace_id: string;
  name: string;
  welcome_text: string | null;
  completion_text: string | null;
  is_default: boolean;
  multilingual: boolean;
  welcome_text_uz: string | null;
  completion_text_uz: string | null;
}

export interface Question {
  id: string;
  survey_id: string;
  position: number;
  type: QuestionType;
  text: string;
  options: Option[];
  allow_other: boolean;
  required: boolean;
  text_uz: string | null;
  show_if: { question_id: string; option_ids: string[] } | null;
  validation: Validation;
  is_language: boolean;
}

export type Validation = "none" | "number" | "age" | "phone_uz" | "email";

export interface WorkHours {
  from: string;
  to: string;
  days: number[];
  text: string;
  text_uz: string;
}

export interface Channel {
  id: string;
  workspace_id: string;
  platform: Platform;
  name: string;
  external_id: string;
  username: string | null;
  survey_id: string | null;
  is_active: boolean;
  status: "pending" | "active" | "error";
  token_hint: string | null;
  token_expires_at: string | null;
  last_event_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  deleted_at: string | null;
}

export interface Lead {
  id: string;
  workspace_id: string;
  channel_id: string;
  contact_id: string;
  survey_id: string | null;
  status: LeadStatus;
  current_question_id: string | null;
  handoff: boolean;
  assigned_to: string | null;
  note: string | null;
  unread_count: number;
  last_message_at: string;
  last_message_preview: string | null;
  created_at: string;
  follow_up_at: string | null;
  tags: string[];
  source: string | null;
  contacts: { display_name: string | null; username: string | null; phone: string | null; external_id: string } | null;
  channels: { platform: Platform; name: string } | null;
}

export interface Answer {
  id: string;
  lead_id: string;
  question_id: string | null;
  question_text: string;
  position: number;
  answer_text: string | null;
}

export interface Message {
  id: string;
  direction: "in" | "out";
  sender: "contact" | "bot" | "agent";
  text: string | null;
  options: Option[];
  attachment: string | null;
  status: "received" | "queued" | "sent" | "failed";
  error: string | null;
  created_at: string;
}

export interface SupportMessage {
  id: string;
  workspace_id: string;
  sender: "owner" | "platform";
  author_email: string | null;
  text: string;
  attachment_path: string | null;
  attachment_name: string | null;
  read_at: string | null;
  created_at: string;
}

export interface SupportTemplate {
  id: string;
  title: string;
  text: string;
}

export interface SupportThread {
  workspace_id: string;
  name: string;
  last_at: string;
  last_text: string;
  last_sender: "owner" | "platform";
  unread: number;
  status: "open" | "resolved";
}

export interface Contact {
  id: string;
  display_name: string | null;
  username: string | null;
  phone: string | null;
}

export interface StudentGroup {
  id: string;
  workspace_id: string;
  name: string;
}

export interface StudentGroupMember {
  id: string;
  group_id: string;
  contact_id: string | null;
  name: string;
  phone: string | null;
}
