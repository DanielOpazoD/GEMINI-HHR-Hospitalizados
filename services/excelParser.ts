
import * as XLSX from 'xlsx';
import { Patient, DailyStats, AnalysisReport, PatientSnapshot } from '../types';

// --- HELPERS ---

const cleanRut = (rut: any): string => {
  if (!rut) return '';
  return String(rut).replace(/\./g, '').replace(/-/g, '').trim().toUpperCase();
};

const normalizeName = (name: string): string => {
  if (!name) return '';
  return name.toString().toUpperCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Remove accents
    .replace(/[^A-Z\s]/g, "") // Remove non-letters (keep spaces)
    .replace(/\s+/g, " ") // Collapse multiple spaces
    .trim();
};

// --- DATE PARSING & CONTEXT ---

const SPANISH_MONTHS: Record<string, number> = {
  'ENERO': 0, 'FEBRERO': 1, 'MARZO': 2, 'ABRIL': 3, 'MAYO': 4, 'JUNIO': 5,
  'JULIO': 6, 'AGOSTO': 7, 'SEPTIEMBRE': 8, 'OCTUBRE': 9, 'NOVIEMBRE': 10, 'DICIEMBRE': 11
};

interface DateContext {
  year: number | null;
  month: number | null; // 0-indexed
}

const getContextFromFilename = (filename: string): DateContext => {
  const upper = filename.toUpperCase();
  let month: number | null = null;
  let year: number | null = null;

  for (const [name, idx] of Object.entries(SPANISH_MONTHS)) {
    if (upper.includes(name)) {
      month = idx;
      break;
    }
  }

  const yearMatch = upper.match(/(202\d)/);
  if (yearMatch) {
    year = parseInt(yearMatch[1], 10);
  }

  return { month, year };
};

const extractDateParts = (str: string) => {
  const match = str.match(/(\d{1,2})[\s.\-/]+(\d{1,2})(?:[\s.\-/]+(\d{2,4}))?/);
  if (!match) return null;
  
  return {
    p1: parseInt(match[1], 10),
    p2: parseInt(match[2], 10),
    p3: match[3] ? parseInt(match[3], 10) : null
  };
};

const parseExcelDate = (excelDate: any, context: { year: number, month: number | null }): Date | null => {
  if (!excelDate) return null;
  if (excelDate instanceof Date) return excelDate;
  
  if (typeof excelDate === 'number') {
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
      year = context.year;
    }

    // DISAMBIGUATION LOGIC (Fix for "01-11" confusion)
    // If context month is set, we force the matching number to be the month.
    if (context.month !== null) {
        // Javascript months are 0-11. Parts are 1-12.
        const contextMonthVal = context.month + 1;
        
        // Case 1: p2 matches context month (Standard DD-MM)
        if (parts.p2 === contextMonthVal) {
            day = parts.p1;
            month = parts.p2 - 1;
        } 
        // Case 2: p1 matches context month (US Format MM-DD) - rare but possible
        else if (parts.p1 === contextMonthVal) {
            day = parts.p2;
            month = parts.p1 - 1;
        }
        // Case 3: Neither matches context.
        // If context is strong (from filename), we trust context year, but what about month?
        // We fallback to standard DD-MM-YYYY
        else {
             day = parts.p1;
             month = parts.p2 - 1;
        }
    } else {
        // No context? Standard DD-MM
        day = parts.p1;
        month = parts.p2 - 1;
    }

    const date = new Date(year, month, day);
    // Basic validation
    if (date.getMonth() !== month) return null; 
    
    return date;
  }
  return null;
};

const isHeaderRow = (row: any[]): boolean => {
  const str = row.join(' ').toUpperCase();
  return (str.includes('CAMA') && str.includes('PACIENTE')) || 
         (str.includes('RUT') && (str.includes('DIAG') || str.includes('PATOLOGIA') || str.includes('PATOLOGÍA')));
};

const isUPC = (val: any): boolean => {
  if (!val) return false;
  const s = String(val).toUpperCase();
  return s === 'SI' || s === 'X' || s.includes('UPC') || s.includes('UCI') || s.includes('UTI');
};

// --- STAGE 1: PARSE EXCEL TO SNAPSHOTS ---

export const parseExcelToSnapshots = async (file: File): Promise<PatientSnapshot[]> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = XLSX.read(data, { type: 'binary' });
        
        // 1. Establish Context
        const fileContext = getContextFromFilename(file.name);
        const sheetNames = workbook.SheetNames;
        
        const yearCounts: Record<number, number> = {};
        const monthCounts: Record<number, number> = {};
        
        // Scan for explicit years in sheet names to help context
        sheetNames.forEach(name => {
            const parts = extractDateParts(name);
            if (parts && parts.p3 !== null) {
                let y = parts.p3;
                if (y < 100) y += 2000;
                yearCounts[y] = (yearCounts[y] || 0) + 1;
                // Also count months if they are explicit
                const m = parts.p2 - 1;
                if (m >= 0 && m <= 11) {
                    monthCounts[m] = (monthCounts[m] || 0) + 1;
                }
            }
        });

        let dominantYear = fileContext.year || new Date().getFullYear();
        let maxYearCount = 0;
        Object.entries(yearCounts).forEach(([yStr, count]) => {
            if (count > maxYearCount) {
                maxYearCount = count;
                dominantYear = parseInt(yStr, 10);
            }
        });

        // Resolve Dominant Month (Context)
        // Priority: Filename > Most Frequent Month in Sheets
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
        const snapshots: PatientSnapshot[] = [];

        // 2. Sort Sheets Chronologically
        const sheetsWithDates = sheetNames.map(name => {
            const date = parseExcelDate(name, globalContext);
            return { name, date };
        }).filter((item): item is { name: string, date: Date } => item.date !== null);

        sheetsWithDates.sort((a, b) => a.date.getTime() - b.date.getTime());

        // 3. Extract Snapshots
        sheetsWithDates.forEach(({ name: sheetName, date: currentDate }) => {
            const sheet = workbook.Sheets[sheetName];
            const jsonData: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
            
            let currentBlock: 'HOSPITALIZED' | 'DISCHARGED' | 'TRANSFERRED' | 'NONE' = 'NONE';
            let headerFound = false;
            let colMap: Record<string, number> = {};

            for (let i = 0; i < jsonData.length; i++) {
                const row = jsonData[i];
                const rowStr = row.join(' ').toUpperCase();

                // Block Detection
                if (rowStr.includes('ALTAS') && rowStr.length < 50) { 
                    currentBlock = 'DISCHARGED';
                    continue;
                }
                if (rowStr.includes('TRASLADOS') && rowStr.length < 50) {
                    currentBlock = 'TRANSFERRED';
                    continue;
                }

                if (!headerFound && isHeaderRow(row)) {
                    headerFound = true;
                    currentBlock = 'HOSPITALIZED';
                    row.forEach((cell: any, idx: number) => {
                        const c = String(cell).toUpperCase().trim();
                        if (c.includes('RUT')) colMap['RUT'] = idx;
                        if (c.includes('PACIENTE') || c.includes('NOMBRE')) colMap['NAME'] = idx;
                        if (c.includes('EDAD')) colMap['AGE'] = idx;
                        if (c.includes('TIPO')) colMap['BEDTYPE'] = idx;
                        if (c.includes('UPC')) colMap['UPC'] = idx;
                        if (c.includes('PATOLOGIA') || c.includes('PATOLOGÍA') || c.includes('DIAGNOSTICO') || c === 'DIAG' || c === 'DG' || c === 'DIAG.') colMap['DIAG'] = idx;
                    });
                    continue;
                }

                if (headerFound && row.length > 2) {
                    const rutRaw = row[colMap['RUT']];
                    const nameRaw = row[colMap['NAME']];
                    const diagRaw = row[colMap['DIAG']] ? String(row[colMap['DIAG']]).trim() : '';

                    // --- CRITICAL FIX: Ghost Header Detection ---
                    // If the row contains "NOMBRE" in the Name column or "RUT" in the RUT column, it's a repeated header.
                    const nameCheck = String(nameRaw || '').toUpperCase().trim();
                    const rutCheck = String(rutRaw || '').toUpperCase().trim();
                    if (nameCheck === 'NOMBRE' || nameCheck.includes('NOMBRE DEL PACIENTE') || rutCheck === 'RUT') {
                        continue;
                    }

                    // --- FILTERING RULES ---
                    const nameNorm = normalizeName(String(nameRaw || ''));
                    
                    // 1. Ignore "BLOQUEO"
                    if (nameNorm.startsWith('BLOQUEO') || nameNorm.includes('BLOQUEO CAMA')) continue;
                    
                    // 2. Ignore empty rows (Must have Name)
                    if (!nameNorm) continue;

                    // 3. Ignore if missing RUT AND Diagnosis (Quality filter)
                    const rutClean = cleanRut(rutRaw);
                    if (!rutClean && !diagRaw) continue;

                    // Bed Type Normalization
                    let rawBedType = row[colMap['BEDTYPE']] ? String(row[colMap['BEDTYPE']]).trim().toUpperCase() : 'INDEFINIDO';
                    if (rawBedType === 'C.M.A' || rawBedType === 'C.M.A.' || rawBedType.includes('MAYOR AMBULATORIA')) rawBedType = 'CMA';
                    if (rawBedType === 'MEDIA' || rawBedType === 'CAMA MEDIA' || rawBedType === 'MEDIO') rawBedType = 'MEDIA';

                    snapshots.push({
                        date: currentDate,
                        rut: rutClean, 
                        name: String(nameRaw).trim(), 
                        diagnosis: diagRaw,
                        bedType: rawBedType,
                        isUPC: isUPC(row[colMap['UPC']]),
                        status: currentBlock === 'NONE' ? 'HOSPITALIZED' : currentBlock,
                        sourceFile: file.name
                    });
                }
            }
        });

        resolve(snapshots);

      } catch (err) {
        console.error("Error parsing file:", file.name, err);
        reject(err);
      }
    };
    reader.readAsBinaryString(file);
  });
};

// --- STAGE 2: RECONCILE SNAPSHOTS (UNIFIED TIMELINE) ---

export const reconcileSnapshots = (snapshots: PatientSnapshot[]): Patient[] => {
    const sorted = [...snapshots].sort((a, b) => a.date.getTime() - b.date.getTime());
    const coveredDates = new Set<string>();
    sorted.forEach(s => coveredDates.add(s.date.toISOString().split('T')[0]));

    // Group Priority: RUT > Normalized Name
    const patientGroups = new Map<string, PatientSnapshot[]>();
    sorted.forEach(s => {
        let key = s.rut;
        if (!key || key === 'SIN-RUT') {
            key = 'NAME-' + normalizeName(s.name);
        }
        if (!patientGroups.has(key)) patientGroups.set(key, []);
        patientGroups.get(key)!.push(s);
    });

    const events: Patient[] = [];

    patientGroups.forEach((patientSnaps, patientKey) => {
        patientSnaps.sort((a, b) => a.date.getTime() - b.date.getTime());
        let currentEvent: Patient | null = null;

        for (let i = 0; i < patientSnaps.length; i++) {
            const snap = patientSnaps[i];
            const snapDateStr = snap.date.toISOString().split('T')[0];
            
            let isGap = false;
            if (currentEvent) {
                const lastDate = currentEvent.lastSeen;
                const diffTime = snap.date.getTime() - lastDate.getTime();
                const diffDays = Math.round(diffTime / (1000 * 3600 * 24));
                
                if (diffDays > 1) {
                    const dayAfterLast = new Date(lastDate);
                    dayAfterLast.setDate(dayAfterLast.getDate() + 1);
                    const dayAfterStr = dayAfterLast.toISOString().split('T')[0];

                    if (coveredDates.has(dayAfterStr)) {
                        isGap = true; 
                    } else {
                         if (diffDays > 5) isGap = true;
                    }
                }
            }

            if (!currentEvent || isGap || (currentEvent.status !== 'Hospitalizado')) {
                if (currentEvent && isGap && currentEvent.status === 'Hospitalizado') {
                    const implicitDischargeDate = new Date(currentEvent.lastSeen);
                    implicitDischargeDate.setDate(implicitDischargeDate.getDate() + 1);
                    currentEvent.dischargeDate = implicitDischargeDate;
                    currentEvent.status = 'Alta';
                    const diff = Math.ceil((implicitDischargeDate.getTime() - currentEvent.firstSeen.getTime()) / (86400000));
                    currentEvent.los = diff || 1;
                }

                currentEvent = {
                    id: `${patientKey}-${snapDateStr}`,
                    rut: snap.rut || '',
                    name: snap.name,
                    age: 0, 
                    diagnosis: snap.diagnosis,
                    bedType: snap.bedType,
                    isUPC: snap.isUPC,
                    wasEverUPC: snap.isUPC,
                    firstSeen: snap.date,
                    lastSeen: snap.date,
                    status: 'Hospitalizado',
                    los: 0,
                    history: [snapDateStr]
                };
                events.push(currentEvent);
            } else {
                currentEvent.lastSeen = snap.date;
                currentEvent.history.push(snapDateStr);
                
                currentEvent.bedType = snap.bedType || currentEvent.bedType;
                currentEvent.isUPC = snap.isUPC; 
                if (snap.isUPC) currentEvent.wasEverUPC = true;
                
                if (snap.diagnosis && snap.diagnosis.length > (currentEvent.diagnosis || '').length) {
                    currentEvent.diagnosis = snap.diagnosis;
                }
            }

            if (snap.status === 'DISCHARGED') {
                // FALLBACK: If explicit discharge but we don't know when they left (missing dates),
                // we use the current snapshot date. But per requirement, if they disappear, it's discharge.
                // If they are in the "Altas" list, the discharge date is valid.
                
                // Logic update: If present in 'DISCHARGED' block, use lastSeen as discharge date?
                // Or use the date of the sheet? 
                // Previous fix: "lastSeen" from logic. But here snap.date IS the sheet date.
                // If patient appears in ALTAS list on day X. It means they were discharged on Day X.
                currentEvent.dischargeDate = snap.date;
                currentEvent.status = 'Alta';
            } else if (snap.status === 'TRANSFERRED') {
                currentEvent.transferDate = snap.date;
                currentEvent.status = 'Traslado';
            }
        }

        if (currentEvent && currentEvent.status === 'Hospitalizado') {
            const dayAfterLast = new Date(currentEvent.lastSeen);
            dayAfterLast.setDate(dayAfterLast.getDate() + 1);
            const dayAfterStr = dayAfterLast.toISOString().split('T')[0];
            
            if (coveredDates.has(dayAfterStr)) {
                currentEvent.dischargeDate = dayAfterLast;
                currentEvent.status = 'Alta';
            }
        }

        events.filter(e => e.rut === patientKey || `NAME-${normalizeName(e.name)}` === patientKey).forEach(e => {
             let end = e.lastSeen;
             if (e.dischargeDate) end = e.dischargeDate;
             if (e.transferDate) end = e.transferDate;
             
             const diff = Math.ceil((end.getTime() - e.firstSeen.getTime()) / (86400000));
             e.los = diff === 0 ? 1 : diff;
        });
    });

    return events;
};

// --- STAGE 3: GENERATE REPORTS ---

// Helper for generating a report for any given period
export const generateReportForPeriod = (events: Patient[], title: string, start: Date, end: Date): AnalysisReport | null => {
    
    // Filter events active in this period
    // Active if: EventStart <= EndDate AND EventEnd >= StartDate
    const activeEvents = events.filter(e => {
        let eventEnd = e.lastSeen;
        if (e.dischargeDate && e.dischargeDate > eventEnd) eventEnd = e.dischargeDate;
        if (e.transferDate && e.transferDate > eventEnd) eventEnd = e.transferDate;
        
        return e.firstSeen <= end && eventEnd >= start;
    });

    if (activeEvents.length === 0) return null;

    const dailyStatsMap = new Map<string, DailyStats>();
    
    // Iterate every day in the range
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        if (d > new Date()) break;
        const dateStr = d.toISOString().split('T')[0];
        
        dailyStatsMap.set(dateStr, {
            date: dateStr,
            totalOccupancy: 0,
            upcOccupancy: 0,
            nonUpcOccupancy: 0,
            admissions: 0,
            discharges: 0,
            transfers: 0
        });
    }

    activeEvents.forEach(e => {
        // Count Admissions
        if (e.firstSeen >= start && e.firstSeen <= end) {
            const admitStr = e.firstSeen.toISOString().split('T')[0];
            if (dailyStatsMap.has(admitStr)) dailyStatsMap.get(admitStr)!.admissions++;
        }

        // Count Discharges
        if (e.dischargeDate && e.dischargeDate >= start && e.dischargeDate <= end) {
            const disStr = e.dischargeDate.toISOString().split('T')[0];
            if (dailyStatsMap.has(disStr)) dailyStatsMap.get(disStr)!.discharges++;
        }
        // Count Transfers
        if (e.transferDate && e.transferDate >= start && e.transferDate <= end) {
            const transStr = e.transferDate.toISOString().split('T')[0];
            if (dailyStatsMap.has(transStr)) dailyStatsMap.get(transStr)!.transfers++;
        }

        // Count Occupancy based on History
        e.history.forEach(hDateStr => {
            const hDate = new Date(hDateStr);
            if (hDate >= start && hDate <= end && dailyStatsMap.has(hDateStr)) {
                 const stat = dailyStatsMap.get(hDateStr)!;
                 stat.totalOccupancy++;
                 if (e.isUPC) stat.upcOccupancy++;
                 else stat.nonUpcOccupancy++;
            }
        });
    });

    const validStats = Array.from(dailyStatsMap.values())
        .filter(d => d.totalOccupancy > 0 || d.admissions > 0 || d.discharges > 0)
        .sort((a, b) => a.date.localeCompare(b.date));

    // Stats Aggregation
    const totalAdm = activeEvents.filter(e => e.firstSeen >= start && e.firstSeen <= end).length;
    const totalDis = validStats.reduce((acc, curr) => acc + curr.discharges, 0);
    
    const uniqueUPC = new Set<string>();
    activeEvents.forEach(p => {
        if (p.wasEverUPC) uniqueUPC.add(p.rut || p.name);
    });

    // Avg LOS for patients DISCHARGED in this period
    const dischargedInPeriod = activeEvents.filter(e => {
        let evEnd = e.dischargeDate || e.transferDate;
        return evEnd && evEnd >= start && evEnd <= end;
    });
    
    const losSum = dischargedInPeriod.reduce((acc, curr) => acc + curr.los, 0);
    const avgLOS = dischargedInPeriod.length > 0 ? parseFloat((losSum / dischargedInPeriod.length).toFixed(1)) : 0;

    return {
        id: `REPORT-${title}-${Date.now()}`,
        title,
        startDate: start,
        endDate: end,
        patients: activeEvents,
        dailyStats: validStats,
        totalAdmissions: totalAdm,
        totalDischarges: totalDis,
        totalUpcPatients: uniqueUPC.size,
        avgLOS,
        occupancyRate: 0
    };
};

export const generateMonthlyReports = (events: Patient[]): AnalysisReport[] => {
    if (events.length === 0) return [];

    let minDate = new Date(8640000000000000);
    let maxDate = new Date(-8640000000000000);

    events.forEach(e => {
        if (e.firstSeen < minDate) minDate = e.firstSeen;
        let end = e.lastSeen;
        if (e.dischargeDate && e.dischargeDate > end) end = e.dischargeDate;
        if (end > maxDate) maxDate = end;
    });

    const reports: AnalysisReport[] = [];
    const currentIter = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
    
    while (currentIter <= maxDate && reports.length < 36) { 
        const monthStart = new Date(currentIter.getFullYear(), currentIter.getMonth(), 1);
        const monthEnd = new Date(currentIter.getFullYear(), currentIter.getMonth() + 1, 0);
        
        const monthNameStr = monthStart.toLocaleString('es-ES', { month: 'long', year: 'numeric' });
        const title = monthNameStr.charAt(0).toUpperCase() + monthNameStr.slice(1);

        const report = generateReportForPeriod(events, title, monthStart, monthEnd);
        if (report) {
            reports.push(report);
        }

        currentIter.setMonth(currentIter.getMonth() + 1);
    }

    return reports;
};
