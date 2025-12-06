
import { Patient, PatientSnapshot, AnalysisReport, DailyStats } from '../types';
import { normalizeName } from '../utils/formatters';

// --- STAGE 2: RECONCILE SNAPSHOTS (UNIFIED TIMELINE) ---

export const reconcileSnapshots = (snapshots: PatientSnapshot[]): Patient[] => {
    // Sort all snapshots chronologically
    const sorted = [...snapshots].sort((a, b) => a.date.getTime() - b.date.getTime());
    
    // Find the absolute last date of data available globally
    const globalMaxDate = sorted.length > 0 ? sorted[sorted.length - 1].date : new Date();

    // --- IDENTITY RESOLUTION MAP ---
    // Connect Names to RUTs to fix gaps where RUT was missing
    // Priority: If a snapshot has RUT, we map Name -> RUT.
    const nameToRutMap = new Map<string, string>();
    sorted.forEach(s => {
        if (s.rut && s.rut.length > 3) {
            const n = normalizeName(s.name);
            if (n) nameToRutMap.set(n, s.rut);
        }
    });

    // Group Snapshots by Identity (RUT preferred, fallback to Name)
    const patientGroups = new Map<string, PatientSnapshot[]>();
    sorted.forEach(s => {
        let key = s.rut;
        const n = normalizeName(s.name);
        
        // If snapshot has no valid RUT, try to find it via Name Map
        if (!key || key.length < 3) {
            if (nameToRutMap.has(n)) {
                key = nameToRutMap.get(n)!;
                // Auto-repair snapshot RUT for consistency
                s.rut = key;
            } else {
                // Fallback: Use Name as ID if RUT is completely unknown
                key = 'NAME-' + n;
            }
        } 

        if (!patientGroups.has(key)) patientGroups.set(key, []);
        patientGroups.get(key)!.push(s);
    });

    const events: Patient[] = [];

    patientGroups.forEach((rawSnaps, patientKey) => {
        // 1. Sort by date
        rawSnaps.sort((a, b) => a.date.getTime() - b.date.getTime());

        // 2. CONSOLIDATE SAME-DAY SNAPSHOTS
        // This merges duplicates if a patient appears multiple times in one day (e.g., bed change)
        const consolidatedSnaps: PatientSnapshot[] = [];
        if (rawSnaps.length > 0) {
            let lastSnap = rawSnaps[0];
            
            for (let i = 1; i < rawSnaps.length; i++) {
                const currentSnap = rawSnaps[i];
                // Compare dates strict (since time is normalized to 12:00:00)
                if (currentSnap.date.getTime() === lastSnap.date.getTime()) {
                    // Merge Strategy
                    // Priority to UPC
                    if (currentSnap.isUPC && !lastSnap.isUPC) {
                        lastSnap = currentSnap;
                    }
                    // Keep Discharged/Transferred status if present
                    if (currentSnap.status !== 'HOSPITALIZED' && lastSnap.status === 'HOSPITALIZED') {
                        lastSnap.status = currentSnap.status;
                    }
                    // Keep Longest Diagnosis
                    if ((currentSnap.diagnosis || '').length > (lastSnap.diagnosis || '').length) {
                        lastSnap.diagnosis = currentSnap.diagnosis;
                    }
                } else {
                    consolidatedSnaps.push(lastSnap);
                    lastSnap = currentSnap;
                }
            }
            consolidatedSnaps.push(lastSnap);
        }
        
        const patientSnaps = consolidatedSnaps;
        let currentEvent: Patient | null = null;

        for (let i = 0; i < patientSnaps.length; i++) {
            const snap = patientSnaps[i];
            const snapDateStr = snap.date.toISOString().split('T')[0];
            
            // Detect Gap (Implicit Discharge)
            let isGap = false;
            let gapDays = 0;

            if (currentEvent) {
                const lastDate = currentEvent.lastSeen;
                const diffTime = snap.date.getTime() - lastDate.getTime();
                gapDays = Math.round(diffTime / (1000 * 3600 * 24)) - 1; // Days strictly between records
                
                // Gap Rule: Tolerance is now 1 day to handle missing Sunday sheets, etc.
                // If gapDays is 1 (e.g. Sat -> Mon), we treat as continuous.
                if (gapDays > 1) {
                    isGap = true; 
                }
            }

            // --- START NEW EVENT OR CLOSE PREVIOUS ---
            if (!currentEvent || isGap) {
                // Close previous event if it was left hanging (Implicit discharge)
                if (currentEvent && isGap && currentEvent.status === 'Hospitalizado') {
                    // IMPLICIT DISCHARGE RULE:
                    // If patient was seen on Day X and disappears, discharge date is Day X + 1.
                    
                    const implicitDischargeDate = new Date(currentEvent.lastSeen);
                    implicitDischargeDate.setDate(implicitDischargeDate.getDate() + 1); 
                    
                    currentEvent.dischargeDate = implicitDischargeDate;
                    currentEvent.status = 'Alta';
                    
                    const diff = Math.ceil((implicitDischargeDate.getTime() - currentEvent.firstSeen.getTime()) / (86400000));
                    currentEvent.los = diff > 0 ? diff : 1;
                }

                currentEvent = {
                    id: `${patientKey}-${snapDateStr}`,
                    rut: snap.rut || (patientKey.startsWith('NAME-') ? '' : patientKey),
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
                    daysInPeriod: 0,
                    history: [snapDateStr],
                    inconsistencies: []
                };

                if (snap.status === 'DISCHARGED') {
                     currentEvent.status = 'Alta';
                     currentEvent.dischargeDate = snap.date;
                     currentEvent.los = 1;
                } else if (snap.status === 'TRANSFERRED') {
                     currentEvent.status = 'Traslado';
                     currentEvent.transferDate = snap.date;
                     currentEvent.los = 1;
                }

                events.push(currentEvent);

            } else {
                // --- CONTINUE EXISTING EVENT ---
                
                // RESURRECTION LOGIC:
                // If the event was closed (Discharged/Transferred) but the patient reappears within the continuity window (<= 1 day gap),
                // we cancel the discharge and extend the stay. This merges "split events".
                if (currentEvent.status === 'Alta' || currentEvent.status === 'Traslado') {
                    currentEvent.status = 'Hospitalizado';
                    currentEvent.dischargeDate = undefined;
                    currentEvent.transferDate = undefined;
                }

                currentEvent.lastSeen = snap.date;
                currentEvent.history.push(snapDateStr);
                
                // Update Metadata
                currentEvent.bedType = snap.bedType || currentEvent.bedType;
                currentEvent.isUPC = snap.isUPC; // Current status
                if (snap.isUPC) currentEvent.wasEverUPC = true; // Historical flag
                
                if (snap.diagnosis && snap.diagnosis.length > (currentEvent.diagnosis || '').length) {
                    currentEvent.diagnosis = snap.diagnosis;
                }

                if (snap.status === 'DISCHARGED') {
                    currentEvent.dischargeDate = snap.date;
                    currentEvent.status = 'Alta';
                } else if (snap.status === 'TRANSFERRED') {
                    currentEvent.transferDate = snap.date;
                    currentEvent.status = 'Traslado';
                }
            }
        }

        // --- FINALIZE LAST EVENT ---
        if (currentEvent && currentEvent.status === 'Hospitalizado') {
            const isAtGlobalEnd = currentEvent.lastSeen.getTime() === globalMaxDate.getTime();
            
            if (isAtGlobalEnd) {
                // Still hospitalized
                currentEvent.dischargeDate = undefined;
                currentEvent.status = 'Hospitalizado';
                const diff = Math.ceil((currentEvent.lastSeen.getTime() - currentEvent.firstSeen.getTime()) / (86400000));
                currentEvent.los = diff > 0 ? diff : 1; 
            } else {
                // Implicit Discharge
                const implicitDischargeDate = new Date(currentEvent.lastSeen);
                implicitDischargeDate.setDate(implicitDischargeDate.getDate() + 1);
                currentEvent.dischargeDate = implicitDischargeDate;
                currentEvent.status = 'Alta';
                const diff = Math.ceil((implicitDischargeDate.getTime() - currentEvent.firstSeen.getTime()) / (86400000));
                currentEvent.los = diff > 0 ? diff : 1;
            }
        } else if (currentEvent) {
             let end = currentEvent.lastSeen;
             if (currentEvent.dischargeDate) end = currentEvent.dischargeDate;
             if (currentEvent.transferDate) end = currentEvent.transferDate;
             
             const diff = Math.ceil((end.getTime() - currentEvent.firstSeen.getTime()) / (86400000));
             currentEvent.los = diff > 0 ? diff : 1;
        }
    });

    return events;
};

// --- STAGE 3: GENERATE REPORTS (STRICT PERIOD LOGIC) ---

export const generateReportForPeriod = (events: Patient[], title: string, start: Date, end: Date): AnalysisReport | null => {
    // 1. Identify active events in this period
    const periodEvents = events.filter(e => {
        const eventEnd = e.dischargeDate || e.transferDate || new Date(8640000000000000);
        return e.firstSeen <= end && eventEnd >= start;
    }).map(e => ({...e})); 

    if (periodEvents.length === 0) return null;

    const dailyStatsMap = new Map<string, DailyStats>();
    
    // Initialize Daily Stats for the period
    const cursor = new Date(start);
    while (cursor <= end) {
        if (cursor > new Date()) break; 
        const dateStr = cursor.toISOString().split('T')[0];
        dailyStatsMap.set(dateStr, {
            date: dateStr,
            totalOccupancy: 0,
            upcOccupancy: 0,
            nonUpcOccupancy: 0,
            admissions: 0,
            discharges: 0,
            transfers: 0
        });
        cursor.setDate(cursor.getDate() + 1);
    }

    let totalAdmissions = 0;
    let totalDischarges = 0;
    const uniqueUPC = new Set<string>();

    // 2. Compute Period-Specific Metrics
    periodEvents.forEach(e => {
        let daysInThisPeriod = 0;
        const eventEnd = e.dischargeDate || e.transferDate;

        if (e.firstSeen >= start && e.firstSeen <= end) {
            totalAdmissions++;
            const dStr = e.firstSeen.toISOString().split('T')[0];
            if (dailyStatsMap.has(dStr)) dailyStatsMap.get(dStr)!.admissions++;
        }

        if (eventEnd && eventEnd >= start && eventEnd <= end) {
            totalDischarges++;
            const dStr = eventEnd.toISOString().split('T')[0];
            if (dailyStatsMap.has(dStr)) {
                if (e.status === 'Traslado') dailyStatsMap.get(dStr)!.transfers++;
                else dailyStatsMap.get(dStr)!.discharges++;
            }
        }

        if (e.wasEverUPC) uniqueUPC.add(e.rut || e.name);

        // Bed Day Calculation (Chilean Normative)
        const dayCursor = new Date(start);
        while (dayCursor <= end) {
             const currentDateStr = dayCursor.toISOString().split('T')[0];
             const isAdmitted = e.firstSeen <= dayCursor;
             const isNotDischarged = !eventEnd || dayCursor < eventEnd;

             if (isAdmitted && isNotDischarged) {
                 if (dailyStatsMap.has(currentDateStr)) {
                     const stat = dailyStatsMap.get(currentDateStr)!;
                     stat.totalOccupancy++;
                     if (e.isUPC) stat.upcOccupancy++;
                     else stat.nonUpcOccupancy++;

                     daysInThisPeriod++;
                 }
             }
             dayCursor.setDate(dayCursor.getDate() + 1);
        }
        e.daysInPeriod = daysInThisPeriod;
    });

    const validStats = Array.from(dailyStatsMap.values())
        .filter(s => s.totalOccupancy > 0 || s.admissions > 0 || s.discharges > 0)
        .sort((a, b) => a.date.localeCompare(b.date));

    const dischargedInPeriod = periodEvents.filter(e => {
        const endD = e.dischargeDate || e.transferDate;
        return endD && endD >= start && endD <= end;
    });
    
    const losSum = dischargedInPeriod.reduce((acc, curr) => acc + curr.los, 0);
    const avgLOS = dischargedInPeriod.length > 0 ? parseFloat((losSum / dischargedInPeriod.length).toFixed(1)) : 0;

    return {
        id: `REPORT-${title}-${Date.now()}`,
        title,
        startDate: start,
        endDate: end,
        patients: periodEvents, 
        dailyStats: validStats,
        totalAdmissions,
        totalDischarges,
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
    
    while (currentIter <= maxDate) { 
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

    return reports.slice(-36); 
};
