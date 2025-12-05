import * as XLSX from 'xlsx';
import { Patient, DailyStats, MonthlyReport } from '../types';

// Helper to clean RUTs
const cleanRut = (rut: any): string => {
  if (!rut) return 'SIN-RUT';
  return String(rut).replace(/\./g, '').replace(/-/g, '').trim().toUpperCase();
};

// Helper to normalize names for fuzzy matching
// Removes accents, special chars, and extra spaces
const normalizeName = (name: string): string => {
  if (!name) return '';
  return name.toString().toUpperCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Remove accents
    .replace(/[^A-Z\s]/g, "") // Remove non-letters (keep spaces)
    .replace(/\s+/g, " ") // Collapse multiple spaces
    .trim();
};

// --- DATE PARSING CONTEXT LOGIC ---

const SPANISH_MONTHS: Record<string, number> = {
  'ENERO': 0, 'FEBRERO': 1, 'MARZO': 2, 'ABRIL': 3, 'MAYO': 4, 'JUNIO': 5,
  'JULIO': 6, 'AGOSTO': 7, 'SEPTIEMBRE': 8, 'OCTUBRE': 9, 'NOVIEMBRE': 10, 'DICIEMBRE': 11
};

interface DateContext {
  year: number | null;
  month: number | null; // 0-indexed
}

// Extract potential context from filename (e.g., "11. NOVIEMBRE (1).xlsx")
const getContextFromFilename = (filename: string): DateContext => {
  const upper = filename.toUpperCase();
  let month: number | null = null;
  let year: number | null = null;

  // Find Month Name
  for (const [name, idx] of Object.entries(SPANISH_MONTHS)) {
    if (upper.includes(name)) {
      month = idx;
      break;
    }
  }

  // Find Year (4 digits, reasonably recent)
  const yearMatch = upper.match(/(202\d)/);
  if (yearMatch) {
    year = parseInt(yearMatch[1], 10);
  }

  return { month, year };
};

// Extract raw numbers from a date string like "01-11" or "05.11.25"
const extractDateParts = (str: string) => {
  // Matches: Num separator Num [separator Num]
  // Separators: - . / space
  // Examples: "1-11", "01.11", "01/11/2025"
  const match = str.match(/(\d{1,2})[\s.\-/]+(\d{1,2})(?:[\s.\-/]+(\d{2,4}))?/);
  
  if (!match) return null;
  
  return {
    p1: parseInt(match[1], 10),
    p2: parseInt(match[2], 10),
    p3: match[3] ? parseInt(match[3], 10) : null
  };
};

// Primary Date Parsing Function
// Uses the determined context (Month/Year) to disambiguate strings like "01-11"
const parseExcelDate = (excelDate: any, context: { year: number, month: number | null }): Date | null => {
  if (!excelDate) return null;
  if (excelDate instanceof Date) return excelDate;
  
  // Handle Excel serial date (Number)
  if (typeof excelDate === 'number') {
    // Excel base date: Dec 30 1899 usually. 
    // Approx calc: (value - 25569) * 86400 * 1000
    return new Date(Math.round((excelDate - 25569) * 86400 * 1000));
  }
  
  if (typeof excelDate === 'string') {
    const parts = extractDateParts(excelDate);
    if (!parts) return null;

    let day: number, month: number, year: number;
    
    // Normalize Year
    if (parts.p3 !== null) {
      year = parts.p3;
      if (year < 100) year += 2000;
    } else {
      year = context.year; // Use context year if missing
    }

    // DISAMBIGUATION LOGIC
    // We have p1 and p2. One is Day, one is Month.
    // Standard ES format: DD-MM
    
    if (context.month !== null) {
      // If we KNOW the month (e.g. November = 10), enforce it.
      // Check if p2 is Month (11)
      if (parts.p2 === context.month + 1) {
        day = parts.p1;
        month = parts.p2 - 1;
      } 
      // Check if p1 is Month (11) - Rare reversed case (MM-DD)
      else if (parts.p1 === context.month + 1) {
        day = parts.p2;
        month = parts.p1 - 1;
      }
      // If neither matches strictly, but p2 looks like a valid month for the year...
      else {
        // Fallback: Assume Standard DD-MM
        day = parts.p1;
        month = parts.p2 - 1;
      }
    } else {
      // No context month known. Assume Standard DD-MM
      day = parts.p1;
      month = parts.p2 - 1;
    }

    const date = new Date(year, month, day);
    
    // Validation: JS auto-rolls over dates (e.g. Feb 30 -> Mar 2). Check if match.
    if (date.getMonth() !== month) return null;

    return date;
  }
  return null;
};

// Heuristic to check if a row looks like a header
const isHeaderRow = (row: any[]): boolean => {
  const str = row.join(' ').toUpperCase();
  // Add support for PATOLOGÍA with accent
  return (str.includes('CAMA') && str.includes('PACIENTE')) || 
         (str.includes('RUT') && (str.includes('DIAG') || str.includes('PATOLOGIA') || str.includes('PATOLOGÍA')));
};

const isUPC = (val: any): boolean => {
  if (!val) return false;
  const s = String(val).toUpperCase();
  return s === 'SI' || s === 'X' || s.includes('UPC') || s.includes('UCI') || s.includes('UTI');
};

// Helper to find a patient in the active map, either by RUT or by Name
const findActivePatient = (rut: string, name: string, activeAdmissions: Map<string, Patient>): Patient | undefined => {
  // 1. Try exact RUT match first (most reliable)
  if (rut && rut !== 'SIN-RUT' && activeAdmissions.has(rut)) {
    return activeAdmissions.get(rut);
  }

  // 2. Fallback: Try Name match
  // This handles cases where Discharge block has missing RUT
  const targetName = normalizeName(name);
  if (!targetName) return undefined;

  for (const patient of activeAdmissions.values()) {
    if (normalizeName(patient.name) === targetName) {
      return patient;
    }
  }

  return undefined;
};

export const processExcelFile = async (file: File): Promise<MonthlyReport> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = XLSX.read(data, { type: 'binary' });
        
        // --- STEP 1: ESTABLISH CONTEXT (THE "TRUTH") ---
        // 1. Guess from Filename
        const fileContext = getContextFromFilename(file.name);
        
        // 2. Guess from Sheets (find unambiguous dates)
        const sheetNames = workbook.SheetNames;
        const yearCounts: Record<number, number> = {};
        const monthCounts: Record<number, number> = {};
        
        sheetNames.forEach(name => {
            const parts = extractDateParts(name);
            if (parts && parts.p3 !== null) { // Has Year
                let y = parts.p3;
                if (y < 100) y += 2000;
                yearCounts[y] = (yearCounts[y] || 0) + 1;
                
                // If has year, p2 is likely month (DD-MM-YYYY)
                const m = parts.p2 - 1; // 0-indexed
                if (m >= 0 && m <= 11) {
                    monthCounts[m] = (monthCounts[m] || 0) + 1;
                }
            }
        });

        // Determine Dominant Year
        let dominantYear = fileContext.year || new Date().getFullYear();
        let maxYearCount = 0;
        Object.entries(yearCounts).forEach(([yStr, count]) => {
            if (count > maxYearCount) {
                maxYearCount = count;
                dominantYear = parseInt(yStr, 10);
            }
        });

        // Determine Dominant Month
        // Filename takes precedence. If not in filename, use sheet consensus.
        let dominantMonth = fileContext.month;
        if (dominantMonth === null) {
            let maxMonthCount = 0;
            Object.entries(monthCounts).forEach(([mStr, count]) => {
                if (count > maxMonthCount) {
                    maxMonthCount = count;
                    dominantMonth = parseInt(mStr, 10);
                }
            });
        }

        const globalContext = { year: dominantYear, month: dominantMonth };
        
        // --- STEP 2: PARSE SHEETS WITH CONTEXT ---
        const sheetsWithDates = sheetNames.map(name => {
            const date = parseExcelDate(name, globalContext);
            return { name, date };
        }).filter((item): item is { name: string, date: Date } => item.date !== null);

        // Sort by date ascending
        sheetsWithDates.sort((a, b) => a.date.getTime() - b.date.getTime());

        // --- STEP 3: PROCESS DATA DAY BY DAY ---
        
        // Key: Clean RUT. Value: Current Patient Object (Event).
        const activeAdmissions = new Map<string, Patient>();
        
        // Completed events (Discharged/Transferred) go here.
        const completedEvents: Patient[] = [];

        const dailyStatsMap = new Map<string, DailyStats>();
        
        sheetsWithDates.forEach(({ name: sheetName, date: currentDate }) => {
          const sheet = workbook.Sheets[sheetName];
          const jsonData: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
          
          const dateStr = currentDate.toISOString().split('T')[0];
          
          // Initialize daily stat
          const dailyStat: DailyStats = {
            date: dateStr,
            totalOccupancy: 0,
            upcOccupancy: 0,
            nonUpcOccupancy: 0,
            admissions: 0, 
            discharges: 0,
            transfers: 0
          };

          let currentBlock: 'HOSPITALIZED' | 'DISCHARGED' | 'TRANSFERRED' | 'NONE' = 'NONE';
          let headerFound = false;
          let colMap: Record<string, number> = {};

          // Track who was seen specifically in THIS sheet to detect implicit discharges later
          const seenInThisSheet = new Set<string>(); // Stores IDs (RUTs)
          const explicitlyProcessedInThisSheet = new Set<string>(); // Stores IDs of explicit discharges/transfers

          // Helper to process a row data
          const extractPatientData = (row: any[]) => {
            const rut = row[colMap['RUT']];
            const name = row[colMap['NAME']];
            
            // Allow processing if Name exists, even if RUT is missing (for Discharge blocks)
            if (!name) return null;
            
            const cleanId = rut ? cleanRut(rut) : 'SIN-RUT';
            const isPatientUPC = isUPC(row[colMap['UPC']]);
            
            // Normalize Bed Type
            let rawBedType = row[colMap['BEDTYPE']] ? String(row[colMap['BEDTYPE']]).trim().toUpperCase() : 'INDEFINIDO';
            
            // Fix specific bed types like CMA
            if (rawBedType === 'C.M.A' || rawBedType === 'C.M.A.' || rawBedType.includes('MAYOR AMBULATORIA')) {
              rawBedType = 'CMA';
            }
            // Normalize variants of "MEDIA"
            if (rawBedType === 'MEDIA' || rawBedType === 'CAMA MEDIA' || rawBedType === 'MEDIO') {
              rawBedType = 'MEDIA';
            }

            // Clean Diagnosis
            const rawDiag = row[colMap['DIAG']] ? String(row[colMap['DIAG']]).trim() : '';

            return {
              rutStr: rut ? String(rut) : '',
              cleanId,
              name: String(name).trim(),
              age: row[colMap['AGE']] || 0,
              diagnosis: rawDiag,
              bedType: rawBedType,
              isUPC: isPatientUPC
            };
          };

          for (let i = 0; i < jsonData.length; i++) {
            const row = jsonData[i];
            const rowStr = row.join(' ').toUpperCase();

            // Detect Blocks
            if (rowStr.includes('ALTAS') && rowStr.length < 50) { 
              currentBlock = 'DISCHARGED';
              continue;
            }
            if (rowStr.includes('TRASLADOS') && rowStr.length < 50) {
              currentBlock = 'TRANSFERRED';
              continue;
            }

            // Detect Header
            if (!headerFound && isHeaderRow(row)) {
              headerFound = true;
              currentBlock = 'HOSPITALIZED';
              row.forEach((cell: any, idx: number) => {
                const c = String(cell).toUpperCase().trim();
                // Improved Column Mapping
                if (c.includes('RUT')) colMap['RUT'] = idx;
                if (c.includes('PACIENTE') || c.includes('NOMBRE')) colMap['NAME'] = idx;
                if (c.includes('EDAD')) colMap['AGE'] = idx;
                if (c.includes('CAMA') && !c.includes('TIPO')) colMap['BED'] = idx;
                if (c.includes('TIPO')) colMap['BEDTYPE'] = idx;
                if (c.includes('UPC')) colMap['UPC'] = idx;
                // Add support for PATOLOGÍA (with accent)
                if (c.includes('PATOLOGIA') || c.includes('PATOLOGÍA') || c.includes('DIAGNOSTICO') || c === 'DIAG' || c === 'DG' || c === 'DIAG.') colMap['DIAG'] = idx;
              });
              continue;
            }

            // Process Rows
            if (headerFound && row.length > 2) {
               const pData = extractPatientData(row);
               if (!pData) continue;
               
               if (currentBlock === 'HOSPITALIZED') {
                 dailyStat.totalOccupancy++;
                 if (pData.isUPC) dailyStat.upcOccupancy++;
                 else dailyStat.nonUpcOccupancy++;

                 let patient = activeAdmissions.get(pData.cleanId);
                 seenInThisSheet.add(pData.cleanId);

                 if (!patient) {
                    // NEW ADMISSION (or Re-admission)
                    const eventId = `${pData.cleanId}-${dateStr}`;
                    const newPatient: Patient = {
                      id: eventId,
                      rut: pData.rutStr,
                      name: pData.name,
                      age: pData.age,
                      diagnosis: pData.diagnosis,
                      bedType: pData.bedType,
                      isUPC: pData.isUPC,
                      wasEverUPC: pData.isUPC,
                      firstSeen: currentDate!,
                      lastSeen: currentDate!,
                      status: 'Hospitalizado',
                      los: 0,
                      history: [dateStr]
                    };
                    activeAdmissions.set(pData.cleanId, newPatient);
                 } else {
                   // EXISTING ADMISSION
                   patient.lastSeen = currentDate!;
                   patient.history.push(dateStr);
                   patient.bedType = pData.bedType || patient.bedType;
                   patient.isUPC = pData.isUPC; // Current status
                   if (pData.isUPC) patient.wasEverUPC = true; // Latch flag
                   
                   if (pData.diagnosis && pData.diagnosis.length > (patient.diagnosis || '').length) {
                     patient.diagnosis = pData.diagnosis;
                   }
                 }

               } else if (currentBlock === 'DISCHARGED') {
                 dailyStat.discharges++;
                 const patient = findActivePatient(pData.cleanId, pData.name, activeAdmissions);

                 if (patient) {
                   patient.dischargeDate = currentDate; 
                   patient.status = 'Alta';
                   
                   if (pData.diagnosis && pData.diagnosis.length > (patient.diagnosis || '').length) {
                     patient.diagnosis = pData.diagnosis;
                   }
                   
                   completedEvents.push(patient);
                   const keyToDelete = Array.from(activeAdmissions.entries()).find(([k, v]) => v === patient)?.[0];
                   if (keyToDelete) {
                     activeAdmissions.delete(keyToDelete);
                     explicitlyProcessedInThisSheet.add(keyToDelete);
                   }
                 }
               } else if (currentBlock === 'TRANSFERRED') {
                 dailyStat.transfers++;
                 const patient = findActivePatient(pData.cleanId, pData.name, activeAdmissions);

                 if (patient) {
                   patient.transferDate = currentDate;
                   patient.status = 'Traslado';
                   if (pData.diagnosis && pData.diagnosis.length > (patient.diagnosis || '').length) {
                     patient.diagnosis = pData.diagnosis;
                   }
                   completedEvents.push(patient);
                   const keyToDelete = Array.from(activeAdmissions.entries()).find(([k, v]) => v === patient)?.[0];
                   if (keyToDelete) {
                     activeAdmissions.delete(keyToDelete);
                     explicitlyProcessedInThisSheet.add(keyToDelete);
                   }
                 }
               }
            }
          }
          
          // --- IMPLICIT DISCHARGE CHECK ---
          const activeKeys = Array.from(activeAdmissions.keys());
          activeKeys.forEach(key => {
            if (!seenInThisSheet.has(key) && !explicitlyProcessedInThisSheet.has(key)) {
               const patient = activeAdmissions.get(key);
               if (patient) {
                 patient.dischargeDate = currentDate;
                 patient.status = 'Alta';
                 completedEvents.push(patient);
                 activeAdmissions.delete(key);
                 dailyStat.discharges++;
               }
            }
          });

          dailyStatsMap.set(dateStr, dailyStat);
        });

        // End of all sheets. 
        const remainingPatients = Array.from(activeAdmissions.values());
        
        // SORTING: Sort all events chronologically by admission date
        const allEvents = [...completedEvents, ...remainingPatients].sort((a, b) => 
          a.firstSeen.getTime() - b.firstSeen.getTime()
        );

        // Post-processing: Calculate LOS for all events
        let totalLOS = 0;
        allEvents.forEach(p => {
          let endDate = p.lastSeen;
          if (p.transferDate) endDate = p.transferDate;
          if (p.dischargeDate) endDate = p.dischargeDate;
          
          const diffTime = Math.abs(endDate.getTime() - p.firstSeen.getTime());
          const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
          p.los = diffDays === 0 ? 1 : diffDays;
          
          totalLOS += p.los;
        });

        // Backfill admissions count
        allEvents.forEach(p => {
          const admissionDateStr = p.firstSeen.toISOString().split('T')[0];
          if (dailyStatsMap.has(admissionDateStr)) {
            dailyStatsMap.get(admissionDateStr)!.admissions++;
          }
        });

        const sortedDailyStats = Array.from(dailyStatsMap.values()).sort((a, b) => 
          new Date(a.date).getTime() - new Date(b.date).getTime()
        );

        const totalAdmissions = allEvents.length;
        const totalDischarges = sortedDailyStats.reduce((acc, curr) => acc + curr.discharges, 0);
        const avgLOS = allEvents.length > 0 ? parseFloat((totalLOS / allEvents.length).toFixed(1)) : 0;
        
        // Calculate Unique UPC Patients
        const uniqueUPCRuts = new Set<string>();
        allEvents.forEach(p => {
            if (p.wasEverUPC) {
                const key = p.rut && p.rut !== 'SIN-RUT' ? cleanRut(p.rut) : p.name;
                uniqueUPCRuts.add(key);
            }
        });
        const totalUpcPatients = uniqueUPCRuts.size;

        // Month name Calculation using Global Context
        let monthName = "Reporte Mensual";
        if (globalContext.month !== null) {
            const d = new Date(globalContext.year, globalContext.month, 1);
            const m = d.toLocaleString('es-ES', { month: 'long', year: 'numeric' });
            monthName = m.charAt(0).toUpperCase() + m.slice(1);
        } else if (sortedDailyStats.length > 0) {
           const d = new Date(sortedDailyStats[0].date);
           const m = d.toLocaleString('es-ES', { month: 'long', year: 'numeric' });
           monthName = m.charAt(0).toUpperCase() + m.slice(1);
        }

        resolve({
          id: Date.now().toString() + Math.random(),
          monthName,
          patients: allEvents,
          dailyStats: sortedDailyStats,
          totalAdmissions,
          totalDischarges,
          totalUpcPatients,
          avgLOS,
          occupancyRate: 0 
        });

      } catch (err) {
        console.error(err);
        reject(err);
      }
    };
    reader.readAsBinaryString(file);
  });
};
