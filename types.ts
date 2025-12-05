
export interface RawRow {
  [key: string]: any;
}

export interface PatientSnapshot {
  date: Date;
  rut: string;
  name: string;
  diagnosis: string;
  bedType: string;
  isUPC: boolean;
  status: 'HOSPITALIZED' | 'DISCHARGED' | 'TRANSFERRED';
  sourceFile: string;
}

export interface Patient {
  id: string; // Unique Event ID (e.g., RUT-AdmissionDate)
  rut: string; // Original RUT
  name: string;
  age: number | string;
  diagnosis: string;
  bedType: string; // The most recent or significant bed type
  isUPC: boolean; // Current status
  wasEverUPC: boolean; // Flag: Did they touch UPC during this stay?
  firstSeen: Date;
  lastSeen: Date;
  dischargeDate?: Date;
  transferDate?: Date;
  status: 'Hospitalizado' | 'Alta' | 'Traslado' | 'Desconocido';
  los: number; // Length of Stay
  history: string[]; // Dates seen (ISO strings)
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

export interface AnalysisReport {
  id: string; // Unique ID for the report
  title: string; // e.g., "Noviembre 2025" or "Q1 2025"
  startDate: Date;
  endDate: Date;
  patients: Patient[]; // Events active in this period
  dailyStats: DailyStats[];
  totalAdmissions: number;
  totalDischarges: number;
  totalUpcPatients: number; // Unique individuals who were in UPC
  avgLOS: number;
  occupancyRate: number; // Placeholder
}

export enum FileStatus {
  IDLE,
  PROCESSING,
  SUCCESS,
  ERROR
}
