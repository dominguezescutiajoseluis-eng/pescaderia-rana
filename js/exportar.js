/* ==========================================================================
   PESCADERÍA RANA - EXPORTAR A EXCEL (CSV)
   Está en Configuración a propósito, para no exportar nada sin querer.
   CSV con separador ';' y BOM UTF-8: Excel lo abre directamente en español.
   ========================================================================== */

/** Descarga un texto como fichero */
function descargarCSV(nombre, contenido) {
  const bom = '\uFEFF'; // para que Excel respete los acentos
  const blob = new Blob([bom + contenido], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/** Escapa un valor para CSV (comillas si lleva ;, comillas o saltos) */
function csvCampo(valor) {
  const t = valor === null || valor === undefined ? '' : String(valor);
  if (t.includes(';') || t.includes('"') || t.includes('\n')) {
    return '"' + t.replace(/"/g, '""') + '"';
  }
  return t;
}

/** Exporta todas las facturas, con una fila por producto */
async function exportarFacturasCSV() {
  const facturas = await getAllInvoices();
  if (facturas.length === 0) {
    showToast('No hay facturas que exportar todavía.', 'error');
    return;
  }
  facturas.sort((a, b) => String(a.number).localeCompare(String(b.number), 'es', { numeric: true }));

  const cabecera = ['Nº Factura', 'Fecha', 'Cliente', 'CIF/NIF', 'Teléfono', 'Concepto', 'Lote', 'Cantidad', 'Precio/Kg (€)', 'Subtotal (€)', 'Total factura (€)'];
  const filas = [cabecera.map(csvCampo).join(';')];

  facturas.forEach(inv => {
    const items = inv.items && inv.items.length ? inv.items : [{ concepto: '-', lote: '', cantidad: '', precio_kg: '', subtotal: inv.totalFactura }];
    items.forEach(it => {
      filas.push([
        inv.number,
        formatDateDisplay(inv.date),
        inv.clientName || '',
        inv.clientCif || '',
        inv.clientPhone || '',
        it.concepto,
        it.lote || '',
        it.cantidad,
        it.precio_kg,
        it.subtotal,
        inv.totalFactura,
      ].map(csvCampo).join(';'));
    });
  });

  descargarCSV('facturas_pescaderia_rana.csv', filas.join('\r\n'));
  showToast('Facturas exportadas (' + facturas.length + ')');
}

/** Exporta la agenda de clientes */
async function exportarClientesCSV() {
  const clientes = await getAllClients();
  if (clientes.length === 0) {
    showToast('La agenda está vacía: nada que exportar.', 'error');
    return;
  }
  const cabecera = ['Nombre/Razón Social', 'CIF/NIF', 'Dirección', 'Provincia', 'Teléfono'];
  const filas = [cabecera.map(csvCampo).join(';')];
  clientes.forEach(c => {
    filas.push([c.name || '', c.cif || '', c.address || '', c.province || '', c.phone || ''].map(csvCampo).join(';'));
  });

  descargarCSV('clientes_pescaderia_rana.csv', filas.join('\r\n'));
  showToast('Clientes exportados (' + clientes.length + ')');
}

function initExportarModule() {
  const b1 = document.getElementById('btn-export-invoices-csv');
  const b2 = document.getElementById('btn-export-clients-csv');
  if (b1) b1.addEventListener('click', exportarFacturasCSV);
  if (b2) b2.addEventListener('click', exportarClientesCSV);
}
