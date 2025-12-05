import * as XLSX from 'xlsx';
import { Patient, DailyStats, MonthlyReport } from '../types';

// Helper to clean RUTs
const cleanRut = (rut: any): string => {
  if (!rut) return 'SIN-RUT';
  return String(rut).replace(/\./g, '').replace(/-/g, '').trim().toUpperCase();
};

// Helper to parse Excel dates
const parseExcelDate = (excelDate: any): Date | null => {
  if (!excelDate) return null;
  if (excelDate instanceof Date) return excelDate;
  
  // Handle Excel serial date
  if (typeof excelDate === 'number') {
    // Excel base date logic
    return new Date(Math.round((excelDate - 25569) * 86400 * 1000));
  }
  
  // Handle string dates (DD-MM-YYYY, DD/MM/YYYY, DD.MM.YYYY, etc)
  if (typeof excelDate === 'string') {
    const cleanStr = excelDate.trim();
    // Split by hyphen, slash, dot, or backslash
    const parts = cleanStr.split(/[-/.\\]/);
    
    if (parts.length === 3) {
      let day = parseInt(parts[0], 10);
      let month = parseInt(parts[1], 10) - 1; // Month is 0-indexed in JS
      let year = parseInt(parts[2], 10);

      if (isNaN(day) || isNaN(month) || isNaN(year)) return null;

      // FIX: 2-digit year handling
      // JS Date(99, ...) treats as 1999. We want 2025.
      // If year is < 100, we assume it's 2000+ for this application context
      if (year < 100) {
        year += 2000;
      }
      
      // Safety check: If for some reason the year is parsed as 19xx but we are in 2020s context, 
      // it might be an issue, but standard full years (2025) work fine in new Date(2025, ...)
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
        const sheetNames = workbook.SheetNames;
        
        // Sort sheet names by date
        const sheetsWithDates = sheetNames.map(name => ({
          name,
          date: parseExcelDate(name)
        })).filter(item => item.date !== null);

        // Sort chronological
        sheetsWithDates.sort((a, b) => a.date!.getTime() - b.date!.getTime());

        sheetsWithDates.forEach(({ name: sheetName, date: currentDate }) => {
          const sheet = workbook.Sheets[sheetName];
          const jsonData: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
          
          if (!currentDate) return; 

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

          // Helper to process a row data
          const extractPatientData = (row: any[]) => {
            const rut = row[colMap['RUT']];
            const name = row[colMap['NAME']];
            if (!rut || !name) return null;
            
            const cleanId = cleanRut(rut);
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
              rutStr: String(rut),
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

                 // LOGIC: Check if this patient is currently active
                 if (!activeAdmissions.has(pData.cleanId)) {
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
                    // We count admission in daily stats later by aggregating firstSeen dates
                 } else {
                   // EXISTING ADMISSION - Update data
                   const p = activeAdmissions.get(pData.cleanId)!;
                   p.lastSeen = currentDate!;
                   p.history.push(dateStr);
                   p.bedType = pData.bedType || p.bedType;
                   p.isUPC = pData.isUPC; // Current status
                   if (pData.isUPC) p.wasEverUPC = true; // Latch flag
                   
                   // CRITICAL FIX: Keep the longest diagnosis string found
                   // This prevents overwriting a good diagnosis with an empty one from a later day
                   if (pData.diagnosis && pData.diagnosis.length > (p.diagnosis || '').length) {
                     p.diagnosis = pData.diagnosis;
                   }
                 }

               } else if (currentBlock === 'DISCHARGED') {
                 dailyStat.discharges++;
                 if (activeAdmissions.has(pData.cleanId)) {
                   const p = activeAdmissions.get(pData.cleanId)!;
                   // UPDATED LOGIC: 
                   // If consigned as discharge (appears in ALTAS), 
                   // considered discharged the day before they stopped appearing.
                   // Since they are in ALTAS now (currentDate), they likely were not in HOSPITALIZED today (or were moved).
                   // We use the `lastSeen` date from the HOSPITALIZED block tracking as the discharge date.
                   p.dischargeDate = p.lastSeen;
                   p.status = 'Alta';
                   // Update diagnosis if available in discharge block
                   if (pData.diagnosis && pData.diagnosis.length > (p.diagnosis || '').length) {
                     p.diagnosis = pData.diagnosis;
                   }
                   // Move from active to completed
                   completedEvents.push(p);
                   activeAdmissions.delete(pData.cleanId);
                 }
               } else if (currentBlock === 'TRANSFERRED') {
                 dailyStat.transfers++;
                 if (activeAdmissions.has(pData.cleanId)) {
                   const p = activeAdmissions.get(pData.cleanId)!;
                   p.transferDate = p.lastSeen; // Same logic as discharge
                   p.status = 'Traslado';
                   if (pData.diagnosis && pData.diagnosis.length > (p.diagnosis || '').length) {
                     p.diagnosis = pData.diagnosis;
                   }
                   // Move from active to completed
                   completedEvents.push(p);
                   activeAdmissions.delete(pData.cleanId);
                 }
               }
            }
          }
          
          dailyStatsMap.set(dateStr, dailyStat);
        });

        // End of all sheets. 
        // Any patient still in `activeAdmissions` is still hospitalized at end of month.
        // Move them to the final list.
        const remainingPatients = Array.from(activeAdmissions.values());
        const allEvents = [...completedEvents, ...remainingPatients];

        // Post-processing: Calculate LOS for all events
        let totalLOS = 0;
        
        allEvents.forEach(p => {
          // Determine End Date
          // Priority: Discharge > Transfer > LastSeen
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
                uniqueUPCRuts.add(cleanRut(p.rut));
            }
        });
        const totalUpcPatients = uniqueUPCRuts.size;

        // Month name from first date
        let monthName = "Reporte Mensual";
        if (sortedDailyStats.length > 0) {
           const d = new Date(sortedDailyStats[0].date);
           monthName = d.toLocaleString('es-ES', { month: 'long', year: 'numeric' });
           monthName = monthName.charAt(0).toUpperCase() + monthName.slice(1);
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