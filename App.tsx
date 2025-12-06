
import React, { useState, useEffect } from 'react';
import { Activity, Menu, X, BarChart3, CalendarRange, ChevronDown } from 'lucide-react';
import { FileUploader } from './components/FileUploader';
import { Dashboard } from './components/Dashboard';
import { parseExcelToSnapshots } from './services/excelParser';
import { reconcileSnapshots, generateMonthlyReports, generateReportForPeriod } from './services/reconciliationService';
import { AnalysisReport, PatientSnapshot, Patient } from './types';
import { runTests } from './tests/runTests';

export default function App() {
  const [reports, setReports] = useState<AnalysisReport[]>([]); // Monthly reports
  const [unifiedEvents, setUnifiedEvents] = useState<Patient[]>([]); // All events consolidated
  const [selectedReport, setSelectedReport] = useState<AnalysisReport | null>(null);
  
  // Data Lake: Store all raw snapshots from all files
  const [allSnapshots, setAllSnapshots] = useState<PatientSnapshot[]>([]);
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Analysis Inputs
  const [customStartMonth, setCustomStartMonth] = useState('');
  const [customEndMonth, setCustomEndMonth] = useState('');

  useEffect(() => {
    // Expose test runner to console
    window.runMedicalTests = runTests;
  }, []);

  const handleFileUpload = async (files: File[]) => {
    setLoading(true);
    setError(null);
    try {
      const newSnapshotsArrays = await Promise.all(files.map(file => parseExcelToSnapshots(file)));
      const newSnapshots = newSnapshotsArrays.flat();
      
      if (newSnapshots.length === 0) {
        throw new Error("No se encontraron datos válidos en los archivos.");
      }

      const updatedSnapshots = [...allSnapshots, ...newSnapshots];
      setAllSnapshots(updatedSnapshots);

      const events = reconcileSnapshots(updatedSnapshots);
      setUnifiedEvents(events);

      const generatedReports = generateMonthlyReports(events);
      setReports(generatedReports);

      // Select latest monthly report by default
      if (!selectedReport && generatedReports.length > 0) {
        setSelectedReport(generatedReports[generatedReports.length - 1]);
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Error al procesar archivos.");
    } finally {
      setLoading(false);
    }
  };

  // --- ANALYSIS GENERATORS ---

  const generateYearReport = (year: number) => {
    // 1. Filter events relevant to this year
    const eventsInYear = unifiedEvents.filter(e => 
      e.firstSeen.getFullYear() === year || 
      e.lastSeen.getFullYear() === year
    );

    if (eventsInYear.length === 0) {
      setError(`No hay datos registrados para el año ${year}`);
      return;
    }

    // 2. Determine actual data range (Min Date to Max Date within this year)
    let minDate = new Date(year, 11, 31);
    let maxDate = new Date(year, 0, 1);

    eventsInYear.forEach(e => {
       if (e.firstSeen < minDate) minDate = e.firstSeen;
       if (e.lastSeen > maxDate) maxDate = e.lastSeen;
    });

    // Clamp dates to the requested year
    const yearStart = new Date(year, 0, 1);
    const yearEnd = new Date(year, 11, 31);
    
    // Effective Reporting Period: From the first recorded event of the year to the last.
    const effectiveStart = minDate < yearStart ? yearStart : minDate;
    const effectiveEnd = maxDate > yearEnd ? yearEnd : maxDate;

    // Safety check: ensure start <= end
    if (effectiveStart > effectiveEnd) {
       // Fallback to full year if something is weird, though logic shouldn't allow this
       generateReportForPeriod(unifiedEvents, `Anual ${year}`, yearStart, yearEnd);
       return;
    }

    // Create report title with actual range info if partial
    let title = `Anual ${year}`;
    if (effectiveEnd.getMonth() < 11 || effectiveStart.getMonth() > 0) {
        const startStr = effectiveStart.toLocaleDateString('es-ES', { month: 'short' });
        const endStr = effectiveEnd.toLocaleDateString('es-ES', { month: 'short' });
        title = `Anual ${year} (${startStr} - ${endStr})`;
    }

    const report = generateReportForPeriod(unifiedEvents, title, effectiveStart, effectiveEnd);
    if (report) setSelectedReport(report);
  };

  const generateQuarterReport = (year: number, quarter: number) => {
    // Q1: 0-2, Q2: 3-5, Q3: 6-8, Q4: 9-11
    const startMonth = (quarter - 1) * 3;
    const endMonth = startMonth + 3;
    const start = new Date(year, startMonth, 1);
    const end = new Date(year, endMonth, 0); // Last day of prev month (so we use endMonth which is next q start, day 0)
    
    const report = generateReportForPeriod(unifiedEvents, `Q${quarter} ${year}`, start, end);
    if (report) setSelectedReport(report);
  };

  const generateCustomRange = () => {
    if (!customStartMonth || !customEndMonth) return;
    
    // Inputs are YYYY-MM
    const [y1, m1] = customStartMonth.split('-').map(Number);
    const [y2, m2] = customEndMonth.split('-').map(Number);
    
    const start = new Date(y1, m1 - 1, 1);
    const end = new Date(y2, m2, 0); // Last day of m2

    if (start > end) {
        setError("La fecha de inicio debe ser anterior a la de fin.");
        return;
    }
    
    const report = generateReportForPeriod(unifiedEvents, `Periodo Personalizado`, start, end);
    if (report) setSelectedReport(report);
    else setError("No hay datos para el periodo seleccionado.");
  };

  // Determine available years from data
  const years = Array.from<number>(new Set(unifiedEvents.map(e => e.firstSeen.getFullYear()))).sort((a, b) => b - a);
  const currentYear = years.length > 0 ? years[0] : new Date().getFullYear();

  return (
    <div className="min-h-screen bg-slate-50 flex font-sans">
      {/* Sidebar - Desktop */}
      <aside className={`
        fixed inset-y-0 left-0 z-50 w-72 bg-slate-900 text-white transform transition-transform duration-300 ease-in-out shadow-xl flex flex-col
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        lg:relative lg:translate-x-0
      `}>
        <div className="p-6 border-b border-slate-800 flex justify-between items-center flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 p-2 rounded-lg">
               <Activity className="h-6 w-6 text-white" />
            </div>
            <div>
              <h1 className="font-bold text-lg leading-tight">Hanga Roa</h1>
              <span className="text-xs text-slate-400 font-medium tracking-wide">ANALÍTICA</span>
            </div>
          </div>
          <button onClick={() => setSidebarOpen(false)} className="lg:hidden text-slate-400 hover:text-white">
            <X size={20} />
          </button>
        </div>

        <nav className="p-4 space-y-6 flex-1 overflow-y-auto">
          {/* Monthly Reports */}
          <div>
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 px-2">Mensuales</div>
            <div className="space-y-1">
              {reports.length === 0 && (
                <div className="px-2 py-3 text-sm text-slate-600 italic border border-dashed border-slate-700 rounded-lg">
                  Sin datos. Carga Excel.
                </div>
              )}
              {reports.map(report => (
                <button
                  key={report.id}
                  onClick={() => setSelectedReport(report)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                    selectedReport?.id === report.id 
                      ? 'bg-blue-600 text-white shadow-md' 
                      : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  <BarChart3 size={16} />
                  {report.title}
                </button>
              ))}
            </div>
          </div>

          {/* Advanced Analysis */}
          {unifiedEvents.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 px-2 border-t border-slate-800 pt-4">
                Análisis Agregado
              </div>
              
              <div className="space-y-1">
                 {years.map(year => (
                    <div key={year} className="space-y-1">
                       <button
                          onClick={() => generateYearReport(year)}
                          className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-sm text-slate-300 hover:bg-slate-800 hover:text-white"
                       >
                         <span className="flex items-center gap-2"><CalendarRange size={16} /> Anual {year}</span>
                       </button>
                       <div className="grid grid-cols-4 gap-1 px-2">
                          {[1,2,3,4].map(q => (
                             <button 
                               key={q}
                               onClick={() => generateQuarterReport(year, q)}
                               className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 py-1 rounded"
                             >
                               Q{q}
                             </button>
                          ))}
                       </div>
                    </div>
                 ))}
              </div>

              {/* Custom Range */}
              <div className="mt-4 px-2 space-y-2 bg-slate-800/50 p-3 rounded-lg">
                <p className="text-xs text-slate-400 font-medium mb-2">Rango Personalizado</p>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-slate-500 block mb-0.5">Inicio</label>
                    <input 
                      type="month" 
                      className="w-full bg-slate-700 border-none text-white text-xs rounded px-2 py-1"
                      value={customStartMonth}
                      onChange={e => setCustomStartMonth(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-500 block mb-0.5">Fin</label>
                    <input 
                      type="month" 
                      className="w-full bg-slate-700 border-none text-white text-xs rounded px-2 py-1"
                      value={customEndMonth}
                      onChange={e => setCustomEndMonth(e.target.value)}
                    />
                  </div>
                </div>
                <button 
                  onClick={generateCustomRange}
                  className="w-full mt-2 bg-slate-700 hover:bg-blue-600 text-white text-xs py-1.5 rounded transition-colors"
                >
                  Generar Reporte
                </button>
              </div>
            </div>
          )}
        </nav>

        <div className="p-4 border-t border-slate-800">
           <div className="flex items-center gap-3 text-xs text-slate-500">
             <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center">
               <span className="font-bold text-slate-300">DO</span>
             </div>
             <div>
               <p className="text-slate-300 font-medium">Dr. Daniel Opazo</p>
               <p>Medicina Interna</p>
             </div>
           </div>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-screen overflow-hidden">
        {/* Top Navbar Mobile */}
        <header className="bg-white border-b border-gray-200 p-4 flex items-center gap-4 lg:hidden">
          <button onClick={() => setSidebarOpen(true)} className="text-gray-600">
            <Menu size={24} />
          </button>
          <span className="font-semibold text-gray-800">Analizador Estadístico</span>
        </header>

        {/* Scrollable Area */}
        <main className="flex-1 overflow-auto p-4 lg:p-8">
          <div className="max-w-7xl mx-auto space-y-8">
            
            {/* Uploader Section - Always visible if no report selected or just above */}
            {!selectedReport && (
              <div className="max-w-2xl mx-auto mt-12 animate-in slide-in-from-bottom-4 duration-500">
                <div className="text-center mb-8">
                  <h2 className="text-3xl font-bold text-gray-900 mb-2">Bienvenido al Analizador</h2>
                  <p className="text-gray-500">
                    Herramienta local y segura para procesar estadísticas de hospitalizados. 
                    Selecciona los archivos Excel mensuales para comenzar.
                  </p>
                </div>
                <FileUploader onFileUpload={handleFileUpload} isLoading={loading} />
                {error && (
                  <div className="mt-4 p-4 bg-red-50 text-red-700 rounded-lg text-sm border border-red-200">
                    {error}
                  </div>
                )}
              </div>
            )}

            {selectedReport && (
              <>
                 {/* Mini Uploader to add more months */}
                <div className="flex justify-between items-center bg-blue-50 p-4 rounded-xl border border-blue-100">
                   <div className="text-sm text-blue-800">
                     <span className="font-semibold">¿Necesitas agregar más meses?</span> Sube archivos adicionales para unificar el análisis.
                   </div>
                   <div className="relative">
                      <input 
                        type="file" 
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                        accept=".xlsx,.xls"
                        multiple
                        onChange={(e) => {
                          if (e.target.files && e.target.files.length > 0) {
                            handleFileUpload(Array.from(e.target.files));
                          }
                        }}
                      />
                      <button className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-1.5 rounded-lg text-xs font-medium transition-colors pointer-events-none">
                        Subir archivos
                      </button>
                   </div>
                </div>

                <Dashboard report={selectedReport} />
              </>
            )}

          </div>
        </main>
      </div>
    </div>
  );
}
