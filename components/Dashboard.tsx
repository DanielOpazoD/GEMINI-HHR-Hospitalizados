
import React, { useMemo, useState } from 'react';
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  BarChart, Bar, PieChart, Pie, Cell
} from 'recharts';
import { Users, Activity, LogOut, Clock, Filter, Download, HeartPulse, X, AlertTriangle } from 'lucide-react';
import { AnalysisReport, Patient } from '../types';
import * as XLSX from 'xlsx';

interface DashboardProps {
  report: AnalysisReport;
}

// Consistent colors for specific bed types
const BED_COLORS: Record<string, string> = {
  'MEDIA': '#3b82f6', // Blue
  'UTI': '#ef4444', // Red
  'UCI': '#f97316', // Orange
  'PENSIONADO': '#10b981', // Green
  'CIRUGIA': '#8b5cf6', // Purple
  'CMA': '#06b6d4', // Cyan (Cirugía Mayor Ambulatoria)
  'MATERNIDAD': '#ec4899', // Pink
  'PEDIATRIA': '#f59e0b', // Amber
  'INDEFINIDO': '#94a3b8' // Slate
};
const DEFAULT_COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042'];

// Helper to format RUT: 12345678K -> 12.345.678-K
const formatRut = (rut: string): string => {
  if (!rut || rut.length < 2) return rut;
  // If already formatted, return
  if (rut.includes('-')) return rut;
  
  const dv = rut.slice(-1);
  const body = rut.slice(0, -1);
  const formattedBody = body.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${formattedBody}-${dv}`;
};

export const Dashboard: React.FC<DashboardProps> = ({ report }) => {
  const [filter, setFilter] = useState<'ALL' | 'UPC' | 'MEDIA'>('ALL');
  const [activeTab, setActiveTab] = useState<'OVERVIEW' | 'PATIENTS'>('OVERVIEW');
  const [showUpcModal, setShowUpcModal] = useState(false);

  // KPIS
  const maxOccupancy = report.dailyStats.length > 0 ? Math.max(...report.dailyStats.map(d => d.totalOccupancy)) : 0;
  const avgOccupancy = report.dailyStats.length > 0 ? Math.round(report.dailyStats.reduce((acc, curr) => acc + curr.totalOccupancy, 0) / report.dailyStats.length) : 0;
  
  // Pie Chart Data
  const bedTypeDist = useMemo(() => {
    const counts: Record<string, number> = {};
    report.patients.forEach(p => {
      // Normalize again just to be safe for display grouping
      const type = p.bedType ? p.bedType.toUpperCase().trim() : 'INDEFINIDO';
      counts[type] = (counts[type] || 0) + 1;
    });
    return Object.keys(counts).map(key => ({ name: key, value: counts[key] }));
  }, [report]);

  // UPC Patients List for Modal
  const upcPatientsList = useMemo(() => {
    return report.patients.filter(p => p.wasEverUPC);
  }, [report]);

  const downloadCSV = () => {
    // Flatten patient data for CSV
    const rows = report.patients.map(p => ({
      RUT: formatRut(p.rut),
      Nombre: p.name,
      Edad: p.age,
      Diagnóstico: p.diagnosis,
      'Tipo Cama Final': p.bedType,
      'Pasó por UPC': p.wasEverUPC ? 'SI' : 'NO',
      'Es UPC Actualmente': p.isUPC ? 'SI' : 'NO',
      'Fecha Ingreso (Evento)': p.firstSeen.toLocaleDateString(),
      'Fecha Egreso': p.dischargeDate ? p.dischargeDate.toLocaleDateString() : (p.transferDate ? p.transferDate.toLocaleDateString() : ''),
      'Fecha Última Vista': p.lastSeen.toLocaleDateString(),
      'Estado Final': p.status,
      'Estadía Total (Días)': p.los,
      'Días Cama Periodo': p.daysInPeriod,
      'Inconsistencias': p.inconsistencies.join(' | ')
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Pacientes_Eventos");
    XLSX.writeFile(wb, `Reporte_${report.title.replace(/\s+/g, '_')}.xlsx`);
  };

  const filteredPatients = useMemo(() => {
    return report.patients.filter(p => {
      if (filter === 'ALL') return true;
      if (filter === 'UPC') return p.wasEverUPC; // Show anyone who touched UPC in this event
      if (filter === 'MEDIA') return !p.wasEverUPC;
      return true;
    });
  }, [report, filter]);

  return (
    <div className="space-y-6 animate-in fade-in duration-500 relative">
      
      {/* Header Actions */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">{report.title}</h2>
          <p className="text-gray-500 text-sm">
            {report.startDate.toLocaleDateString()} — {report.endDate.toLocaleDateString()}
          </p>
        </div>
        <div className="flex gap-2">
          <div className="bg-white p-1 rounded-lg border border-gray-200 flex">
            <button 
              onClick={() => setActiveTab('OVERVIEW')}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${activeTab === 'OVERVIEW' ? 'bg-blue-100 text-blue-700 shadow-sm' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              Dashboard
            </button>
            <button 
              onClick={() => setActiveTab('PATIENTS')}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${activeTab === 'PATIENTS' ? 'bg-blue-100 text-blue-700 shadow-sm' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              Listado Pacientes
            </button>
          </div>
          <button 
            onClick={downloadCSV}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm font-medium shadow-sm"
          >
            <Download size={16} /> Exportar Excel
          </button>
        </div>
      </div>

      {activeTab === 'OVERVIEW' && (
        <>
          {/* KPI Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            <KpiCard icon={<Users className="text-blue-600" />} title="Ocupación Promedio" value={avgOccupancy} sub={`Máximo: ${maxOccupancy}`} />
            <KpiCard icon={<Activity className="text-indigo-600" />} title="Ingresos (Eventos)" value={report.totalAdmissions} sub="Nuevos en este periodo" />
            
            {/* Clickable UPC Card */}
            <KpiCard 
              icon={<HeartPulse className="text-rose-600" />} 
              title="Pacientes UPC" 
              value={report.totalUpcPatients} 
              sub="Pacientes únicos (Ver detalle)"
              onClick={() => setShowUpcModal(true)}
              className="cursor-pointer hover:bg-rose-50 hover:border-rose-200 transition-colors group"
            />
            
            <KpiCard icon={<LogOut className="text-green-600" />} title="Altas Totales" value={report.totalDischarges} sub="Confirmadas en periodo" />
            <KpiCard icon={<Clock className="text-orange-600" />} title="Estadía Promedio" value={report.avgLOS} sub="Días (Egresados)" />
          </div>

          {/* Charts Row 1 */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
              <h3 className="text-lg font-semibold text-gray-800 mb-4">Evolución Ocupación Diaria</h3>
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={report.dailyStats}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                    <XAxis 
                      dataKey="date" 
                      tickFormatter={(str) => {
                          const d = new Date(str);
                          return `${d.getDate()}/${d.getMonth()+1}`;
                      }} 
                      stroke="#94a3b8"
                      tick={{fontSize: 12}}
                      minTickGap={30}
                    />
                    <YAxis stroke="#94a3b8" tick={{fontSize: 12}} />
                    <Tooltip 
                      labelFormatter={(str) => new Date(str).toLocaleDateString()}
                      contentStyle={{borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'}}
                    />
                    <Legend />
                    <Line type="monotone" dataKey="totalOccupancy" name="Total" stroke="#3b82f6" strokeWidth={2} dot={false} activeDot={{r: 6}} />
                    <Line type="monotone" dataKey="upcOccupancy" name="UPC" stroke="#ef4444" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
              <h3 className="text-lg font-semibold text-gray-800 mb-4">Distribución por Cama</h3>
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={bedTypeDist}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={80}
                      fill="#8884d8"
                      paddingAngle={2}
                      dataKey="value"
                    >
                      {bedTypeDist.map((entry, index) => {
                         // Use fixed color if available, else cycle default colors
                         const color = BED_COLORS[entry.name] || DEFAULT_COLORS[index % DEFAULT_COLORS.length];
                         return <Cell key={`cell-${index}`} fill={color} />;
                      })}
                    </Pie>
                    <Tooltip />
                    <Legend verticalAlign="bottom" height={36}/>
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* Charts Row 2 */}
          <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
            <h3 className="text-lg font-semibold text-gray-800 mb-4">Flujo Diario (Ingresos vs Egresos)</h3>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={report.dailyStats}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                  <XAxis 
                    dataKey="date" 
                    tickFormatter={(str) => {
                        const d = new Date(str);
                        return `${d.getDate()}/${d.getMonth()+1}`;
                    }} 
                    stroke="#94a3b8"
                    tick={{fontSize: 12}}
                    minTickGap={30}
                  />
                  <YAxis stroke="#94a3b8" tick={{fontSize: 12}} />
                  <Tooltip 
                    cursor={{fill: '#f8fafc'}} 
                    labelFormatter={(str) => new Date(str).toLocaleDateString()}
                    contentStyle={{borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'}}
                  />
                  <Legend />
                  <Bar dataKey="admissions" name="Ingresos" fill="#10b981" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="discharges" name="Altas" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="transfers" name="Traslados" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </>
      )}

      {activeTab === 'PATIENTS' && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
           <div className="p-4 border-b border-gray-100 flex gap-4 items-center flex-wrap">
             <div className="relative">
               <Filter className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" size={16} />
               <select 
                className="pl-9 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                value={filter}
                onChange={(e) => setFilter(e.target.value as any)}
               >
                 <option value="ALL">Todos los Eventos</option>
                 <option value="UPC">Estuvo en UPC</option>
                 <option value="MEDIA">Nunca en UPC</option>
               </select>
             </div>
             <div className="text-sm text-gray-500">
               Mostrando {filteredPatients.length} eventos de hospitalización
             </div>
           </div>
           <div className="overflow-x-auto">
             <table className="w-full text-sm text-left">
               <thead className="bg-gray-50 text-gray-700 font-semibold border-b border-gray-200">
                 <tr>
                   <th className="px-6 py-3">Nombre</th>
                   <th className="px-6 py-3">RUT</th>
                   <th className="px-6 py-3">Diagnóstico</th>
                   <th className="px-6 py-3">Cama</th>
                   <th className="px-6 py-3">Ingreso</th>
                   <th className="px-6 py-3">Fecha Egreso</th>
                   <th className="px-6 py-3 text-center bg-blue-50">Días Mes</th>
                   <th className="px-6 py-3 text-center">Estadía Total</th>
                   <th className="px-6 py-3">Estado</th>
                 </tr>
               </thead>
               <tbody className="divide-y divide-gray-100">
                 {filteredPatients.map((p, idx) => (
                   <tr key={p.id} className="hover:bg-gray-50 transition-colors">
                     <td className="px-6 py-3 font-medium text-gray-900">
                       {p.name}
                       {p.inconsistencies.length > 0 && (
                         <div className="group relative inline-block ml-2 align-middle">
                           <div className="text-amber-500 cursor-help">
                             <AlertTriangle size={14} />
                           </div>
                           <div className="invisible group-hover:visible absolute left-0 top-6 z-50 w-64 p-2 bg-gray-900 text-white text-xs rounded shadow-lg border border-gray-800">
                             {p.inconsistencies.map((inc, i) => <div key={i} className="mb-1">• {inc}</div>)}
                           </div>
                         </div>
                       )}
                     </td>
                     <td className="px-6 py-3 text-gray-500 whitespace-nowrap">{formatRut(p.rut)}</td>
                     <td className="px-6 py-3 text-gray-700 max-w-[200px] truncate cursor-help border-b border-dotted border-gray-300" title={p.diagnosis}>
                       {p.diagnosis || '-'}
                     </td>
                     <td className="px-6 py-3">
                       <span className={`px-2 py-1 rounded-full text-xs font-medium ${p.bedType && p.bedType.includes('UPC') ? 'bg-red-50 text-red-700' : 'bg-gray-100 text-gray-700'}`}>
                         {p.bedType || 'Sala'}
                       </span>
                     </td>
                     <td className="px-6 py-3 text-gray-500">{p.firstSeen.toLocaleDateString()}</td>
                     <td className="px-6 py-3 text-gray-500">
                       {p.dischargeDate ? p.dischargeDate.toLocaleDateString() : (p.transferDate ? p.transferDate.toLocaleDateString() : '-')}
                     </td>
                     <td className="px-6 py-3 text-center bg-blue-50 font-bold text-blue-800">
                       {p.daysInPeriod}
                     </td>
                     <td className="px-6 py-3 text-center font-medium text-gray-900">
                       {p.los}
                     </td>
                     <td className="px-6 py-3">
                       <StatusBadge status={p.status} />
                     </td>
                   </tr>
                 ))}
               </tbody>
             </table>
           </div>
        </div>
      )}

      {/* UPC Details Modal */}
      {showUpcModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col animate-in zoom-in-95 duration-200">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-rose-50 rounded-t-2xl">
              <div>
                <h3 className="text-xl font-bold text-rose-900 flex items-center gap-2">
                  <HeartPulse className="text-rose-600" /> Pacientes UPC (Detalle)
                </h3>
                <p className="text-rose-700 text-sm mt-1">Listado de casos que requirieron manejo en Unidad de Paciente Crítico</p>
              </div>
              <button onClick={() => setShowUpcModal(false)} className="p-2 hover:bg-rose-100 rounded-full text-rose-600 transition-colors">
                <X size={24} />
              </button>
            </div>
            
            <div className="overflow-auto p-0 flex-1">
               <table className="w-full text-sm text-left">
                 <thead className="bg-gray-50 text-gray-700 font-semibold sticky top-0 z-10 shadow-sm">
                   <tr>
                     <th className="px-6 py-3">Nombre</th>
                     <th className="px-6 py-3">RUT</th>
                     <th className="px-6 py-3">Diagnóstico</th>
                     <th className="px-6 py-3">Ingreso</th>
                     <th className="px-6 py-3">Fecha Egreso</th>
                     <th className="px-6 py-3">Estadía Total</th>
                     <th className="px-6 py-3">Estado Final</th>
                   </tr>
                 </thead>
                 <tbody className="divide-y divide-gray-100">
                   {upcPatientsList.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-6 py-8 text-center text-gray-500 italic">
                          No se encontraron pacientes UPC en este periodo.
                        </td>
                      </tr>
                   ) : (
                      upcPatientsList.map((p) => (
                        <tr key={p.id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-6 py-3 font-medium text-gray-900">{p.name}</td>
                          <td className="px-6 py-3 text-gray-500 whitespace-nowrap">{formatRut(p.rut)}</td>
                          <td className="px-6 py-3 text-gray-700">{p.diagnosis}</td>
                          <td className="px-6 py-3 text-gray-500">{p.firstSeen.toLocaleDateString()}</td>
                          <td className="px-6 py-3 text-gray-500">
                            {p.dischargeDate ? p.dischargeDate.toLocaleDateString() : (p.transferDate ? p.transferDate.toLocaleDateString() : '-')}
                          </td>
                          <td className="px-6 py-3 text-gray-900 font-semibold">{p.los} días</td>
                          <td className="px-6 py-3"><StatusBadge status={p.status} /></td>
                        </tr>
                      ))
                   )}
                 </tbody>
               </table>
            </div>

            <div className="p-4 border-t border-gray-100 bg-gray-50 rounded-b-2xl flex justify-end">
              <button 
                onClick={() => setShowUpcModal(false)}
                className="px-5 py-2 bg-white border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 font-medium shadow-sm"
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

interface KpiCardProps {
  icon: React.ReactNode;
  title: string;
  value: number;
  sub: string;
  onClick?: () => void;
  className?: string;
}

const KpiCard: React.FC<KpiCardProps> = ({ icon, title, value, sub, onClick, className }) => (
  <div 
    onClick={onClick}
    className={`bg-white p-5 rounded-xl border border-gray-200 shadow-sm flex items-start justify-between min-w-[200px] ${className || ''}`}
  >
    <div>
      <p className="text-sm font-medium text-gray-500 mb-1">{title}</p>
      <h4 className="text-2xl font-bold text-gray-900">{value}</h4>
      <p className="text-xs text-gray-400 mt-1">{sub}</p>
    </div>
    <div className="p-3 bg-gray-50 rounded-lg">
      {icon}
    </div>
  </div>
);

const StatusBadge = ({ status }: { status: string }) => {
  const styles: Record<string, string> = {
    'Hospitalizado': 'bg-blue-100 text-blue-700',
    'Alta': 'bg-green-100 text-green-700',
    'Traslado': 'bg-amber-100 text-amber-700',
    'Desconocido': 'bg-gray-100 text-gray-700'
  };
  return (
    <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${styles[status] || styles['Desconocido']}`}>
      {status}
    </span>
  );
};
