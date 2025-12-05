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

// Strict Helper to parse Excel dates focusing on DD-MM-YYYY format
const parseExcelDate = (excelDate: any): Date | null => {
  if (!excelDate) return null;
  if (excelDate instanceof Date) return excelDate;
  
  // Handle Excel serial date (Number)
  if (typeof excelDate === 'number') {
    // Excel base date logic (approximate for JS)
    return new Date(Math.round((excelDate - 25569) * 86400 * 1000));
  }
  
  // Handle string dates strictly as DD-MM-YYYY
  // User Requirement: "El formato es dia-mes-año"
  if (typeof excelDate === 'string') {
    const cleanStr = excelDate.trim();
    
    // Regex matches: (1 or 2 digits) separator (1 or 2 digits) separator (2 or 4 digits)
    // Separators can be space, dot, hyphen, slash
    // REMOVED anchors (^ $) to allow text like "Sabado 1-11-2025"
    const match = cleanStr.match(/(\d{1,2})[\s.\-/]+(\d{1,2})[\s.\-/]+(\d{2,4})/);

    if (match) {
      const day = parseInt(match[1], 10);
      const month = parseInt(match[2], 10) - 1; // Month is 0-indexed in JS (0=Jan, 3=April)
      let year = parseInt(match[3], 10);

      if (isNaN(day) || isNaN(month) || isNaN(year)) return null;

      // FIX: 2-digit year handling
      // If year is < 100, we assume it's 2000+ for this application context
      // e.g., "25" -> 2025
      if (year < 100) {
        year += 2000;
      }
      
      return new Date(year, month, day);
    }
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
        
        // RE-ARCHITECTED LOGIC:
        // Instead of a map of RUT -> Patient, we maintain "Active Admissions".
        // Key: Clean RUT. Value: Current Patient Object (Event).
        const activeAdmissions = new Map<string, Patient>();
        
        // Completed events (Discharged/Transferred) go here.
        const completedEvents: Patient[] = [];

        const dailyStatsMap = new Map<string, DailyStats>();
        
        // Track month frequency to name the report correctly (Mode)
        const monthFrequency = new Map<string, number>();

        const sheetNames = workbook.SheetNames;
        
        // Sort sheet names by date
        const sheetsWithDates = sheetNames.map(name => ({
          name,
          date: parseExcelDate(name)
        })).filter(item => item.date !== null);

        // Sort chronological
        sheetsWithDates.sort((a, b) => a.date!.getTime() - b.date!.getTime());

        sheetsWithDates.forEach(({ name: sheetName, date: currentDate }) => {
          if (!currentDate) return; 

          // Tally month/year for report naming
          const monthKey = `${currentDate.getFullYear()}-${currentDate.getMonth()}`;
          monthFrequency.set(monthKey, (monthFrequency.get(monthKey) || 0) + 1);

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
                 // For Hospitalized block, we prefer having a valid RUT if possible, but we process anyway
                 dailyStat.totalOccupancy++;
                 if (pData.isUPC) dailyStat.upcOccupancy++;
                 else dailyStat.nonUpcOccupancy++;

                 // LOGIC: Check if this patient is currently active
                 // Note: We use cleanId (RUT) as primary key.
                 let patient = activeAdmissions.get(pData.cleanId);
                 
                 // Mark that we SAW this patient today
                 seenInThisSheet.add(pData.cleanId);

                 if (!patient) {
                    // NEW ADMISSION (or Re-admission)
                    // We generate a unique ID for this specific event to avoid collisions in React keys later
                    const eventId = `${pData.cleanId}-${dateStr}`;
                    
                    const newPatient: Patient = {
                      id: eventId,
                      rut: pData.rutStr,
                      name: pData.name,
                      age: pData.age,
                      diagnosis: pData.diagnosis, // Start with current diagnosis
                      bedType: pData.bedType,
                      isUPC: pData.isUPC,
                      wasEverUPC: pData.isUPC, // Initialize flag
                      firstSeen: currentDate!,
                      lastSeen: currentDate!,
                      status: 'Hospitalizado',
                      los: 0,
                      history: [dateStr]
                    };
                    activeAdmissions.set(pData.cleanId, newPatient);
                 } else {
                   // EXISTING ADMISSION - Update data
                   patient.lastSeen = currentDate!;
                   patient.history.push(dateStr);
                   patient.bedType = pData.bedType || patient.bedType;
                   patient.isUPC = pData.isUPC; // Current status
                   if (pData.isUPC) patient.wasEverUPC = true; // Latch flag
                   
                   // CRITICAL FIX: Keep the longest diagnosis string found
                   if (pData.diagnosis && pData.diagnosis.length > (patient.diagnosis || '').length) {
                     patient.diagnosis = pData.diagnosis;
                   }
                 }

               } else if (currentBlock === 'DISCHARGED') {
                 dailyStat.discharges++;
                 // Match patient using RUT or Name Fallback
                 const patient = findActivePatient(pData.cleanId, pData.name, activeAdmissions);

                 if (patient) {
                   // RULE: Explicit discharge. Date = Current Sheet Date.
                   patient.dischargeDate = currentDate; 
                   patient.status = 'Alta';
                   
                   if (pData.diagnosis && pData.diagnosis.length > (patient.diagnosis || '').length) {
                     patient.diagnosis = pData.diagnosis;
                   }
                   
                   completedEvents.push(patient);
                   
                   // Remove from active map using the KEY we found it with
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
                   patient.transferDate = currentDate; // Explicit transfer, use current date
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
          // Rule: "Aquel dia que no aparece debe ser considerado el dia de alta."
          // If a patient was active (in activeAdmissions) but NOT seen in this sheet's "HOSPITALIZED" block
          // AND NOT explicitly processed in "ALTAS"/"TRASLADOS", then they disappeared today.
          
          // We iterate a copy of keys to safely delete while iterating
          const activeKeys = Array.from(activeAdmissions.keys());
          
          activeKeys.forEach(key => {
            if (!seenInThisSheet.has(key) && !explicitlyProcessedInThisSheet.has(key)) {
               const patient = activeAdmissions.get(key);
               if (patient) {
                 // Found a missing patient.
                 // Discharge Date = Current Date (The first day they are missing)
                 patient.dischargeDate = currentDate;
                 patient.status = 'Alta'; // Assume Discharge if just missing
                 
                 completedEvents.push(patient);
                 activeAdmissions.delete(key);
                 
                 // Optional: Increment discharge count for stats?
                 // The prompt doesn't explicitly say to count implicit discharges in the daily stats bar chart,
                 // but usually, if they left, it's a discharge. Let's count it for consistency in numbers.
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
          // Determine End Date
          let endDate = p.lastSeen;
          if (p.transferDate) endDate = p.transferDate;
          if (p.dischargeDate) endDate = p.dischargeDate;
          
          // Calculate LOS
          const diffTime = Math.abs(endDate.getTime() - p.firstSeen.getTime());
          const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
          p.los = diffDays === 0 ? 1 : diffDays; // Minimum 1 day if seen
          
          totalLOS += p.los;
        });

        // Determine Admissions count per day (Backfill based on event start dates)
        allEvents.forEach(p => {
          const admissionDateStr = p.firstSeen.toISOString().split('T')[0];
          if (dailyStatsMap.has(admissionDateStr)) {
            dailyStatsMap.get(admissionDateStr)!.admissions++;
          }
        });

        const sortedDailyStats = Array.from(dailyStatsMap.values()).sort((a, b) => 
          new Date(a.date).getTime() - new Date(b.date).getTime()
        );

        // Calculate aggregates
        const totalAdmissions = allEvents.length; // Total events
        const totalDischarges = sortedDailyStats.reduce((acc, curr) => acc + curr.discharges, 0);
        const avgLOS = allEvents.length > 0 ? parseFloat((totalLOS / allEvents.length).toFixed(1)) : 0;
        
        // Calculate Unique UPC Patients (People, not events)
        const uniqueUPCRuts = new Set<string>();
        allEvents.forEach(p => {
            if (p.wasEverUPC) {
                // Use Name as part of key if RUT is missing to try to count correctly
                const key = p.rut && p.rut !== 'SIN-RUT' ? cleanRut(p.rut) : p.name;
                uniqueUPCRuts.add(key);
            }
        });
        const totalUpcPatients = uniqueUPCRuts.size;

        // Month name Calculation (MODE)
        // Find the most frequent month/year in the sheets to name the report
        let bestMonthKey = "";
        let maxCount = 0;
        
        monthFrequency.forEach((count, key) => {
            if (count > maxCount) {
                maxCount = count;
                bestMonthKey = key;
            }
        });

        let monthName = "Reporte Mensual";
        if (bestMonthKey) {
            const [yearStr, monthIndexStr] = bestMonthKey.split('-');
            const d = new Date(parseInt(yearStr), parseInt(monthIndexStr), 1);
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
          patients: allEvents, // Contains all distinct hospitalization events
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