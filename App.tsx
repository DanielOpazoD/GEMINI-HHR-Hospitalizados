import React, { useState } from 'react';
import { Activity, Menu, X, BarChart3 } from 'lucide-react';
import { FileUploader } from './components/FileUploader';
import { Dashboard } from './components/Dashboard';
import { parseExcelToSnapshots, reconcileSnapshots, generateMonthlyReports } from './services/excelParser';
import { MonthlyReport, PatientSnapshot } from './types';

export default function App() {
  const [reports, setReports] = useState<MonthlyReport[]>([]);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  
  // Data Lake: Store all raw snapshots from all files
  const [allSnapshots, setAllSnapshots] = useState<PatientSnapshot[]>([]);
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const handleFileUpload = async (files: File[]) => {
    setLoading(true);
    setError(null);
    try {
      // 1. Parse new files into snapshots
      const newSnapshotsArrays = await Promise.all(files.map(file => parseExcelToSnapshots(file)));
      const newSnapshots = newSnapshotsArrays.flat();
      
      if (newSnapshots.length === 0) {
        throw new Error("No se encontraron datos válidos en los archivos.");
      }

      // 2. Append to Data Lake
      // We combine old and new. 
      // Note: Real-world app might need deduplication if same file uploaded twice.
      // For now, we trust the append or could filter by sourceFile if needed.
      const updatedSnapshots = [...allSnapshots, ...newSnapshots];
      setAllSnapshots(updatedSnapshots);

      // 3. Reconcile ALL data to build unified patient timelines
      const unifiedEvents = reconcileSnapshots(updatedSnapshots);

      // 4. Generate Reports from Unified Events
      const generatedReports = generateMonthlyReports(unifiedEvents);

      setReports(generatedReports);

      // Select the most recent report if none selected
      if (!selectedReportId && generatedReports.length > 0) {
        setSelectedReportId(generatedReports[generatedReports.length - 1].id);
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Error al procesar archivos.");
    } finally {
      setLoading(false);
    }
  };

  const selectedReport = reports.find(r => r.id === selectedReportId);

  return (
    <div className="min-h-screen bg-slate-50 flex font-sans">
      {/* Sidebar - Desktop */}
      <aside className={`
        fixed inset-y-0 left-0 z-50 w-64 bg-slate-900 text-white transform transition-transform duration-300 ease-in-out shadow-xl
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        lg:relative lg:translate-x-0
      `}>
        <div className="p-6 border-b border-slate-800 flex justify-between items-center">
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

        <nav className="p-4 space-y-2">
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-4 px-2">Reportes Generados</div>
          
          {reports.length === 0 && (
            <div className="px-2 py-4 text-sm text-slate-600 italic text-center border border-dashed border-slate-700 rounded-lg">
              No hay datos. Carga archivos Excel.
            </div>
          )}

          {reports.map(report => (
            <button
              key={report.id}
              onClick={() => setSelectedReportId(report.id)}
              className={`w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-all ${
                selectedReportId === report.id 
                  ? 'bg-blue-600 text-white shadow-md' 
                  : 'text-slate-300 hover:bg-slate-800 hover:text-white'
              }`}
            >
              <BarChart3 size={18} />
              {report.monthName}
            </button>
          ))}
        </nav>

        <div className="absolute bottom-0 w-full p-4 border-t border-slate-800">
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