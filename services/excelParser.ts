
import * as XLSX from 'xlsx';
import { PatientSnapshot } from '../types';
import { cleanRut, normalizeName } from '../utils/formatters';

// --- HELPERS ---

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
  
  let date: Date | null = null;

  if (excelDate instanceof Date) {
    date = new Date(excelDate);
  } else if (typeof excelDate === 'number') {
    date = new Date(Math.round((excelDate - 25569) * 86400 * 1000));
  } else if (typeof excelDate === 'string') {
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

    // DISAMBIGUATION LOGIC
    if (context.month !== null) {
        const contextMonthVal = context.month + 1;
        // Case 1: p2 matches context month (Standard DD-MM)
        if (parts.p2 === contextMonthVal) {
            day = parts.p1;
            month = parts.p2 - 1;
        } 
        // Case 2: p1 matches context month (US Format MM-DD)
        else if (parts.p1 === contextMonthVal) {
            day = parts.p2;
            month = parts.p1 - 1;
        }
        else {
             day = parts.p1;
             month = parts.p2 - 1;
        }
    } else {
        day = parts.p1;
        month = parts.p2 - 1;
    }

    date = new Date(year, month, day);
  }

  if (date) {
      // FORCE NOON (12:00:00)
      // This is critical to prevent "same day" being treated as different due to time/timezone
      date.setHours(12, 0, 0, 0);
      return date;
  }
  return null;
};

const isHeaderRow = (row: any[]): boolean => {
  const str = row.join(' ').toUpperCase();
  // More robust header detection
  const hasRut = str.includes('RUT');
  const hasName = str.includes('PACIENTE') || str.includes('NOMBRE');
  const hasBed = str.includes('CAMA');
  const hasDiag = str.includes('DIAG') || str.includes('PATOLOGIA') || str.includes('PATOLOGÍA');
  
  return (hasRut && (hasName || hasDiag)) || (hasBed && hasName);
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

                // Detección robusta de bloques
                if (rowStr.length < 200) { 
                  if (rowStr.includes('ALTAS') && !rowStr.includes('NO')) {
                    currentBlock = 'DISCHARGED';
                    continue;
                  }
                  if (rowStr.includes('TRASLADO') || rowStr.includes('TRASLAD') || rowStr.includes('DERIVADO')) {
                    currentBlock = 'TRANSFERRED';
                    continue;
                  }
                }

                if (!headerFound && isHeaderRow(row)) {
                    headerFound = true;
                    // Reset block to Hospitalized when finding main header
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

                    const nameCheck = String(nameRaw || '').toUpperCase().trim();
                    const rutCheck = String(rutRaw || '').toUpperCase().trim();
                    
                    // --- FILTRO DE FILAS FANTASMA Y ENCABEZADOS REPETIDOS ---
                    if (!nameRaw) continue;
                    if (nameCheck === 'NOMBRE' || nameCheck.includes('NOMBRE DEL PACIENTE') || nameCheck === 'PACIENTE') continue;
                    if (rutCheck === 'RUT' || rutCheck === 'RUN') continue;
                    // Extra safety: duplicated header row
                    if (nameCheck === 'NOMBRE' && rutCheck === 'RUT') continue;
                    
                    if (nameCheck.includes('SERVICIO DE') || nameCheck.includes('UNIDAD DE')) continue;
                    if (nameCheck.includes('CAMA') || nameCheck.includes('TIPO DE CAMA')) continue;

                    const nameNorm = normalizeName(String(nameRaw || ''));
                    // Skip blocked beds
                    if (nameNorm.startsWith('BLOQUEO') || nameNorm.includes('BLOQUEO CAMA') || nameNorm.includes('AISLAMIENTO')) continue;
                    if (!nameNorm) continue;

                    const rutClean = cleanRut(rutRaw);
                    
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
