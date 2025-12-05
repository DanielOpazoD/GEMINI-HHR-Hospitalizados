import React, { useCallback } from 'react';
import { Upload, FileSpreadsheet, Loader2 } from 'lucide-react';

interface FileUploaderProps {
  onFileUpload: (file: File) => void;
  isLoading: boolean;
}

export const FileUploader: React.FC<FileUploaderProps> = ({ onFileUpload, isLoading }) => {
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (isLoading) return;
    const file = e.dataTransfer.files[0];
    if (file && (file.name.endsWith('.xlsx') || file.name.endsWith('.xls'))) {
      onFileUpload(file);
    }
  }, [onFileUpload, isLoading]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      onFileUpload(e.target.files[0]);
    }
  };

  return (
    <div 
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
      className={`
        border-2 border-dashed rounded-xl p-8 text-center transition-all duration-200
        ${isLoading ? 'bg-gray-50 border-gray-300 cursor-wait' : 'bg-white border-blue-200 hover:border-blue-400 hover:bg-blue-50 cursor-pointer'}
      `}
    >
      <input 
        type="file" 
        id="file-upload" 
        className="hidden" 
        accept=".xlsx,.xls" 
        onChange={handleChange}
        disabled={isLoading}
      />
      
      <div className="flex flex-col items-center justify-center space-y-4">
        <div className={`p-4 rounded-full ${isLoading ? 'bg-gray-100' : 'bg-blue-100'}`}>
          {isLoading ? (
            <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
          ) : (
            <FileSpreadsheet className="w-8 h-8 text-blue-600" />
          )}
        </div>
        
        <div>
          <h3 className="text-lg font-semibold text-gray-900">
            {isLoading ? 'Procesando archivo...' : 'Cargar Reporte Mensual'}
          </h3>
          <p className="text-sm text-gray-500 mt-1 max-w-xs mx-auto">
            Arrastra tu archivo Excel aquí o haz clic para seleccionar.
            (Formatos .xlsx)
          </p>
        </div>

        {!isLoading && (
          <label 
            htmlFor="file-upload"
            className="px-6 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors shadow-sm cursor-pointer"
          >
            Seleccionar Archivo
          </label>
        )}
      </div>
    </div>
  );
};