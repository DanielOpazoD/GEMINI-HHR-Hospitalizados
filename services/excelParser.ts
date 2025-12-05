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
    return new Date(Math.round((excelDate - 25569) * 86400 * 1000));
  }
  // Handle string dates (DD-MM-YYYY or DD/MM/YYYY or DD.MM.YYYY)
  if (typeof excelDate === 'string') {
    const cleanStr = excelDate.trim();
    const parts = cleanStr.split(/[-/.]/);
    if (parts.length === 3) {
      let day = parseInt(parts[0]);
      let month = parseInt(parts[1]) - 1;
      let year = parseInt(parts[2]);

      if (isNaN(day) || isNaN(month) || isNaN(year)) return null;

      // Fix 2-digit year issue (JS Date treats 0-99 as 1900-1999)
      // We assume for this hospital app that years < 100 are 2000s
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
  return str.includes('CAMA') && str.includes('PACIENTE');
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

            return {
              rutStr: String(rut),
              cleanId,
              name: String(name),
              age: row[colMap['AGE']] || 0,
              diagnosis: row[colMap['DIAG']] || '',
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
                if (c.includes('RUT')) colMap['RUT'] = idx;
                if (c.includes('PACIENTE') || c.includes('NOMBRE')) colMap['NAME'] = idx;
                if (c.includes('EDAD')) colMap['AGE'] = idx;
                if (c.includes('CAMA') && !c.includes('TIPO')) colMap['BED'] = idx;
                if (c.includes('TIPO')) colMap['BEDTYPE'] = idx;
                if (c.includes('UPC')) colMap['UPC'] = idx;
                if (c.includes('PATOLOGIA') || c.includes('DIAGNOSTICO')) colMap['DIAG'] = idx;
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
                      diagnosis: pData.diagnosis,
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
                   
                   // Update diagnosis if it changes to something longer/more detailed? 
                   // Usually keep the latest or the first. Let's keep latest.
                   if (pData.diagnosis) p.diagnosis = pData.diagnosis;
                 }

               } else if (currentBlock === 'DISCHARGED') {
                 dailyStat.discharges++;
                 if (activeAdmissions.has(pData.cleanId)) {
                   const p = activeAdmissions.get(pData.cleanId)!;
                   p.dischargeDate = currentDate!;
                   p.status = 'Alta';
                   // Move from active to completed
                   completedEvents.push(p);
                   activeAdmissions.delete(pData.cleanId);
                 }
               } else if (currentBlock === 'TRANSFERRED') {
                 dailyStat.transfers++;
                 if (activeAdmissions.has(pData.cleanId)) {
                   const p = activeAdmissions.get(pData.cleanId)!;
                   p.transferDate = currentDate!;
                   p.status = 'Traslado';
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
          id: Date.now().toString(),
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