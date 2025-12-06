
export const cleanRut = (rut: any): string => {
  if (!rut) return '';
  // Remove dots, dashes, whitespace. Convert to upper case.
  // Remove leading zeros to ensure 017.xxx and 17.xxx are treated as identical.
  return String(rut).replace(/[^0-9kK]/g, '').toUpperCase().replace(/^0+/, '');
};

export const normalizeName = (name: string): string => {
  if (!name) return '';
  return name.toString().toUpperCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Remove accents
    .replace(/[^A-Z\s]/g, "") // Remove non-letters (keep spaces)
    .replace(/\s+/g, " ") // Collapse multiple spaces
    .trim();
};

export const formatRut = (rut: string): string => {
  if (!rut || rut.length < 2) return rut;
  // If already formatted, return
  if (rut.includes('-')) return rut;
  
  const dv = rut.slice(-1);
  const body = rut.slice(0, -1);
  const formattedBody = body.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${formattedBody}-${dv}`;
};
