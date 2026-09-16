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

export type EventItem = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  office_required: boolean;
  zoom_allowed: boolean;
  venue_allowed: boolean;
  venue_name: string;
  description: string;
};

export type EventResponse = {
  event_id: string;
  participation_type: "office" | "venue" | "zoom" | "absent";
  planned_arrival: string | null;
  planned_departure: string | null;
  attendance_confirmed: boolean;
};

export type EventAttendanceRow = {
  member_id: string;
  full_name: string;
  participation_type: "office" | "venue" | "zoom" | "absent" | null;
  planned_arrival: string | null;
  attendance_confirmed: boolean;
  responded_at: string | null;
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
  status: "active" | "cancelled";
  created_at: string;
  updated_at: string;
};

export type OpenCloseLog = {
  id: string;
  action: "open" | "close";
  performed_by: string;
  created_at: string;
};
