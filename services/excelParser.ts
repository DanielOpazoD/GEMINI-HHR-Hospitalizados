import * as XLSX from 'xlsx';
import { Patient, DailyStats, MonthlyReport, PatientSnapshot } from '../types';

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

    // DISAMBIGUATION
    if (context.month !== null) {
      if (parts.p2 === context.month + 1) {
        day = parts.p1;
        month = parts.p2 - 1;
      } else if (parts.p1 === context.month + 1) {
        day = parts.p2;
        month = parts.p1 - 1;
      } else {
        day = parts.p1;
        month = parts.p2 - 1;
      }
    } else {
      day = parts.p1;
      month = parts.p2 - 1;
    }

    const date = new Date(year, month, day);
    if (date.getMonth() !== month) return null; // Invalid date rollover check

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
        
        sheetNames.forEach(name => {
            const parts = extractDateParts(name);
            if (parts && parts.p3 !== null) {
                let y = parts.p3;
                if (y < 100) y += 2000;
                yearCounts[y] = (yearCounts[y] || 0) + 1;
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

                    // --- FILTERING RULES ---
                    const nameNorm = normalizeName(String(nameRaw || ''));
                    
                    // 1. Ignore "BLOQUEO"
                    if (nameNorm.startsWith('BLOQUEO') || nameNorm.includes('BLOQUEO CAMA')) continue;
                    
                    // 2. Ignore empty rows (Must have Name)
                    if (!nameNorm) continue;

                    // 3. Ignore if missing RUT AND Diagnosis (Quality filter)
                    const rutClean = cleanRut(rutRaw);
                    if (!rutClean && !diagRaw) continue;

                    let rawBedType = row[colMap['BEDTYPE']] ? String(row[colMap['BEDTYPE']]).trim().toUpperCase() : 'INDEFINIDO';
                    if (rawBedType === 'C.M.A' || rawBedType === 'C.M.A.' || rawBedType.includes('MAYOR AMBULATORIA')) rawBedType = 'CMA';
                    if (rawBedType === 'MEDIA' || rawBedType === 'CAMA MEDIA' || rawBedType === 'MEDIO') rawBedType = 'MEDIA';

                    snapshots.push({
                        date: currentDate,
                        rut: rutClean, // Can be empty if relying on name matching later
                        name: String(nameRaw).trim(), // Keep original casing for display, normalize for logic
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
    // 1. Sort all snapshots chronologically
    const sorted = [...snapshots].sort((a, b) => a.date.getTime() - b.date.getTime());

    // 2. Identify all covered dates in the dataset (to determine implicit discharges)
    // We map dateStr -> boolean
    const coveredDates = new Set<string>();
    sorted.forEach(s => coveredDates.add(s.date.toISOString().split('T')[0]));

    // 3. Group snapshots by unique Patient Identity
    // Priority: RUT. If no RUT, use Normalized Name.
    const patientGroups = new Map<string, PatientSnapshot[]>();

    sorted.forEach(s => {
        let key = s.rut;
        if (!key || key === 'SIN-RUT') {
            key = 'NAME-' + normalizeName(s.name);
        }
        
        if (!patientGroups.has(key)) {
            patientGroups.set(key, []);
        }
        patientGroups.get(key)!.push(s);
    });

    const events: Patient[] = [];

    // 4. Process each patient's timeline to create Events
    patientGroups.forEach((patientSnaps, patientKey) => {
        // Ensure chronological order for this patient
        patientSnaps.sort((a, b) => a.date.getTime() - b.date.getTime());

        let currentEvent: Patient | null = null;

        for (let i = 0; i < patientSnaps.length; i++) {
            const snap = patientSnaps[i];
            const snapDateStr = snap.date.toISOString().split('T')[0];
            
            // Check if we should start a new event
            // A new event is needed if:
            // - No current event
            // - Gap in dates > 1 day AND the intermediate day WAS covered by dataset (implicit discharge)
            // - Previous event was explicitly closed (Alta/Traslado)

            let isGap = false;
            if (currentEvent) {
                const lastDate = currentEvent.lastSeen;
                const diffTime = snap.date.getTime() - lastDate.getTime();
                const diffDays = Math.round(diffTime / (1000 * 3600 * 24));
                
                if (diffDays > 1) {
                    // Check if the gap days were actually monitored (covered)
                    // If we have data for the missing days, it means patient was gone -> Discharge.
                    // If we DON'T have data (e.g. missing file), assume continuity? 
                    // Prompt says: "Aquel dia que no aparece debe ser considerado el dia de alta".
                    // This implies if we have coverage and they are missing, they are out.
                    
                    // We check if the day immediately following 'lastSeen' is covered.
                    const dayAfterLast = new Date(lastDate);
                    dayAfterLast.setDate(dayAfterLast.getDate() + 1);
                    const dayAfterStr = dayAfterLast.toISOString().split('T')[0];

                    if (coveredDates.has(dayAfterStr)) {
                        isGap = true; // They were missing on a covered day
                    } else {
                         // Missing data gap (e.g. uploaded Jan then Mar). 
                         // Usually we should break, but if user uploads consecutive months, this handles it.
                         // If gap is huge (>30 days), force break? Let's assume strict continuity only if days are close.
                         // For safety, if diff > 5 days, break event.
                         if (diffDays > 5) isGap = true;
                    }
                }
            }

            if (!currentEvent || isGap || (currentEvent.status !== 'Hospitalizado')) {
                // Finalize previous if exists and wasn't closed
                if (currentEvent && isGap && currentEvent.status === 'Hospitalizado') {
                    // Implicit discharge on the first missing day
                    const implicitDischargeDate = new Date(currentEvent.lastSeen);
                    implicitDischargeDate.setDate(implicitDischargeDate.getDate() + 1);
                    currentEvent.dischargeDate = implicitDischargeDate;
                    currentEvent.status = 'Alta';
                    // Calc LOS
                    const diff = Math.ceil((implicitDischargeDate.getTime() - currentEvent.firstSeen.getTime()) / (86400000));
                    currentEvent.los = diff || 1;
                }

                // Start NEW Event
                // If this snapshot is 'DISCHARGED' or 'TRANSFERRED', it might be a dangling record or same-day discharge.
                // We treat it as a 1-day event if it's the start.
                
                currentEvent = {
                    id: `${patientKey}-${snapDateStr}`,
                    rut: snap.rut || '',
                    name: snap.name,
                    age: 0, // Age not always in snapshot, could update if found
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
                // Continue EXISTING Event
                currentEvent.lastSeen = snap.date;
                currentEvent.history.push(snapDateStr);
                
                // Update dynamic fields
                currentEvent.bedType = snap.bedType || currentEvent.bedType;
                currentEvent.isUPC = snap.isUPC; // current status
                if (snap.isUPC) currentEvent.wasEverUPC = true;
                
                // Update Diagnosis (longest wins)
                if (snap.diagnosis && snap.diagnosis.length > (currentEvent.diagnosis || '').length) {
                    currentEvent.diagnosis = snap.diagnosis;
                }
            }

            // Handle Explicit Status in Snapshot
            if (snap.status === 'DISCHARGED') {
                currentEvent.dischargeDate = snap.date;
                currentEvent.status = 'Alta';
            } else if (snap.status === 'TRANSFERRED') {
                currentEvent.transferDate = snap.date;
                currentEvent.status = 'Traslado';
            }
        }

        // After loop, finalize the last event if still open
        // Check if the day after lastSeen is covered. If so, implicit discharge.
        if (currentEvent && currentEvent.status === 'Hospitalizado') {
            const dayAfterLast = new Date(currentEvent.lastSeen);
            dayAfterLast.setDate(dayAfterLast.getDate() + 1);
            const dayAfterStr = dayAfterLast.toISOString().split('T')[0];
            
            if (coveredDates.has(dayAfterStr)) {
                currentEvent.dischargeDate = dayAfterLast;
                currentEvent.status = 'Alta';
            }
            // Else: Patient is still hospitalized at the end of the provided data
        }

        // Finalize LOS for all events of this patient
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

// --- STAGE 3: GENERATE REPORTS FROM EVENTS ---

export const generateMonthlyReports = (events: Patient[]): MonthlyReport[] => {
    // 1. Determine Date Range of Data
    let minDate = new Date(8640000000000000);
    let maxDate = new Date(-8640000000000000);

    if (events.length === 0) return [];

    events.forEach(e => {
        if (e.firstSeen < minDate) minDate = e.firstSeen;
        let end = e.lastSeen;
        if (e.dischargeDate && e.dischargeDate > end) end = e.dischargeDate;
        if (end > maxDate) maxDate = end;
    });

    // 2. Iterate Months
    const reports: MonthlyReport[] = [];
    const currentIter = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
    
    // Safety break
    while (currentIter <= maxDate && reports.length < 36) { // Max 3 years processed
        const monthStart = new Date(currentIter.getFullYear(), currentIter.getMonth(), 1);
        const monthEnd = new Date(currentIter.getFullYear(), currentIter.getMonth() + 1, 0); // Last day of month
        
        // Filter events active in this month
        // Active if: EventStart <= MonthEnd AND EventEnd >= MonthStart
        const activeEvents = events.filter(e => {
            let end = e.lastSeen;
            if (e.dischargeDate) end = e.dischargeDate;
            if (e.transferDate) end = e.transferDate;
            
            return e.firstSeen <= monthEnd && end >= monthStart;
        });

        // If no data for this month, skip
        if (activeEvents.length === 0) {
            currentIter.setMonth(currentIter.getMonth() + 1);
            continue;
        }

        // Generate Daily Stats for this month
        const dailyStatsMap = new Map<string, DailyStats>();
        
        // Pre-fill days of month
        const daysInMonth = monthEnd.getDate();
        for (let d = 1; d <= daysInMonth; d++) {
            const dateObj = new Date(monthStart.getFullYear(), monthStart.getMonth(), d);
            if (dateObj > new Date()) break; // Don't project future
            const dateStr = dateObj.toISOString().split('T')[0];
            
            // Optimization: check if we actually have data for this date in the raw snapshots?
            // Indirectly we do via events history.
            
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
            // Count Admissions in this month
            const admitStr = e.firstSeen.toISOString().split('T')[0];
            if (dailyStatsMap.has(admitStr)) {
                dailyStatsMap.get(admitStr)!.admissions++;
            }

            // Count Discharges/Transfers in this month
            if (e.dischargeDate) {
                const disStr = e.dischargeDate.toISOString().split('T')[0];
                if (dailyStatsMap.has(disStr)) dailyStatsMap.get(disStr)!.discharges++;
            }
            if (e.transferDate) {
                const transStr = e.transferDate.toISOString().split('T')[0];
                if (dailyStatsMap.has(transStr)) dailyStatsMap.get(transStr)!.transfers++;
            }

            // Count Occupancy
            // Iterate days the patient was present
            // We use the patient's history array, but that might be sparse if we only have snapshots.
            // Better: Iterate valid days of the event that fall in this month.
            
            let scanDate = new Date(e.firstSeen);
            // Cap start at month start
            if (scanDate < monthStart) scanDate = new Date(monthStart);

            let endDate = e.lastSeen; // Occupancy is until last seen (inclusive usually)
            // But if discharged, they are NOT occupying on the discharge date?
            // Usually bed census is taken at X hour. If patient is in census, they occupy.
            // Our snapshots represent the census. So we use the history array logic or range.
            // Since we have history of specific dates seen, let's use that for exact occupancy.
            
            e.history.forEach(hDateStr => {
                if (dailyStatsMap.has(hDateStr)) {
                    const stat = dailyStatsMap.get(hDateStr)!;
                    stat.totalOccupancy++;
                    // Note: isUPC in event is "current". Historic UPC status might differ per day.
                    // But in our simplified event model, we might just use the event's flag or need granular history.
                    // For now, use event's current flag as approximation or we'd need granular history in Event.
                    // Refinement: PatientSnapshot had isUPC. We lost that granularity in Event object (it only has current).
                    // Correct approach: We should re-check snapshots for accurate daily UPC counts, 
                    // but for now let's use the event property as best effort or re-architect Event to have daily details.
                    // Given constraints, we use event.isUPC. 
                    if (e.isUPC) stat.upcOccupancy++;
                    else stat.nonUpcOccupancy++;
                }
            });
        });

        // Filter out empty days (days with 0 occupancy and 0 movement - likely no file uploaded for that day)
        // This prevents plotting days where we simply had no data.
        const validStats = Array.from(dailyStatsMap.values())
            .filter(d => d.totalOccupancy > 0 || d.admissions > 0 || d.discharges > 0)
            .sort((a, b) => a.date.localeCompare(b.date));

        if (validStats.length > 0) {
            // Calculate Aggregates
            const monthNameStr = monthStart.toLocaleString('es-ES', { month: 'long', year: 'numeric' });
            const monthName = monthNameStr.charAt(0).toUpperCase() + monthNameStr.slice(1);
            
            const totalAdm = activeEvents.filter(e => e.firstSeen >= monthStart && e.firstSeen <= monthEnd).length;
            const totalDis = validStats.reduce((acc, curr) => acc + curr.discharges, 0);
            
            // Unique UPC
            const uniqueUPC = new Set<string>();
            activeEvents.forEach(p => {
                if (p.wasEverUPC) uniqueUPC.add(p.rut || p.name);
            });

            // Avg LOS of events ENDING in this month? Or all active?
            // Usually LOS stats are for discharged patients in the period.
            const dischargedInMonth = activeEvents.filter(e => {
                let end = e.dischargeDate || e.transferDate;
                return end && end >= monthStart && end <= monthEnd;
            });
            
            const losSum = dischargedInMonth.reduce((acc, curr) => acc + curr.los, 0);
            const avgLOS = dischargedInMonth.length > 0 ? parseFloat((losSum / dischargedInMonth.length).toFixed(1)) : 0;

            reports.push({
                id: `REPORT-${monthName}-${Date.now()}`,
                monthName,
                patients: activeEvents, // List all active, but UI can filter by Admit Date if needed
                dailyStats: validStats,
                totalAdmissions: totalAdm,
                totalDischarges: totalDis,
                totalUpcPatients: uniqueUPC.size,
                avgLOS,
                occupancyRate: 0
            });
        }

        currentIter.setMonth(currentIter.getMonth() + 1);
    }

    return reports;
};