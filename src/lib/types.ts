export type UserRole = "member" | "key_manager" | "admin";

export type Profile = {
  id: string;
  full_name: string;
  role: UserRole;
  active?: boolean;
  team?: string;
  jurisdiction?: string;
};

export type OfficeCalendarSummary = {
  time_slot: string;
  planned_count: number;
  has_unlock: boolean;
};

export type OfficeStatus = {
  singleton_id: number;
  is_open: boolean;
  updated_by: string | null;
  updated_at: string;
};

export type Reservation = {
  id: string;
  user_id: string;
  visit_date: string;
  start_time: string;
  end_time: string;
  note: string;
  created_at: string;
  updated_at: string;
};

export type OpenCloseLog = {
  id: string;
  action: "open" | "close";
  performed_by: string;
  created_at: string;
};
