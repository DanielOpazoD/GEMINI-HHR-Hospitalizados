export interface RawRow {
  [key: string]: any;
}

export interface Patient {
  id: string; // Unique Event ID (e.g., RUT-AdmissionDate)
  rut: string; // Original RUT
  name: string;
  age: number | string;
  diagnosis: string;
  bedType: string;
  isUPC: boolean; // Current status
  wasEverUPC: boolean; // Flag: Did they touch UPC during this stay?
  firstSeen: Date;
  lastSeen: Date;
  dischargeDate?: Date;
  transferDate?: Date;
  status: 'Hospitalizado' | 'Alta' | 'Traslado' | 'Desconocido';
  los: number; // Length of Stay
  history: string[]; // Dates seen
}

export interface DailyStats {
  date: string; // ISO Date YYYY-MM-DD
  totalOccupancy: number;
  upcOccupancy: number;
  nonUpcOccupancy: number;
  admissions: number;
  discharges: number;
  transfers: number;
}

export interface MonthlyReport {
  id: string; // Unique ID for the report
  monthName: string; // e.g., "Noviembre 2025"
  patients: Patient[]; // This is actually a list of "Events" or "Admissions"
  dailyStats: DailyStats[];
  totalAdmissions: number;
  totalDischarges: number;
  totalUpcPatients: number; // Unique individuals who were in UPC
  avgLOS: number;
  occupancyRate: number; // Placeholder calculation
}

export enum FileStatus {
  IDLE,
  PROCESSING,
  SUCCESS,
  ERROR
}