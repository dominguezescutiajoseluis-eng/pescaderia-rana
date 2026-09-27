/* ==========================================================================
   PESCADERÍA RANA - ENVÍO DE FACTURA POR WHATSAPP (WhatsApp Web)
   - Botón «WhatsApp» en el facturador (envía la factura que se está creando)
   - Botón por cada factura en el Registro de Facturas
   El teléfono se guarda con la factura (campo clientPhone).
   ========================================================================== */

/** Normaliza un teléfono español al formato internacional 34XXXXXXXXX */
function normalizarTelefonoWhatsApp(telefono) {
  if (!telefono) return '';
  let t = String(telefono).replace(/[^\d+]/g, '');
  if (t.startsWith('00')) t = t.slice(2);
  if (t.startsWith('+')) t = t.slice(1);
  if (t.length === 9) t = '34' + t; // móvil/fijo español sin prefijo
  return t;
}

/** Texto del mensaje con el resumen de la factura */
function construirMensajeFactura(inv) {
  const cfg = window.__companyData || {};
  const empresa = cfg.companyName || 'PESCADERÍA RANA';
  const lineas = (inv.items || []).map(it =>
    `• ${it.concepto} (Lote ${it.lote || '-'}): ${formatNumber(it.cantidad)} kg × ${formatNumber(it.precio_kg)} € = ${formatNumber(it.subtotal)} €`
  ).join('\n');

  return `${empresa} — Factura ${inv.number}\n` +
    `Fecha: ${formatDateDisplay(inv.date)}\n` +
    `Cliente: ${inv.clientName || '-'}\n` +
    `\nProductos:\n${lineas}\n` +
    `\nTOTAL: ${formatNumber(inv.totalFactura)} €` +
    `\n\nGracias por su confianza.`;
}

/** Abre WhatsApp Web con el mensaje preparado (no necesita API ni clave) */
function enviarFacturaWhatsApp(inv) {
  if (!inv) return;
  const tel = normalizarTelefonoWhatsApp(inv.clientPhone);
  const texto = encodeURIComponent(construirMensajeFactura(inv));
  const url = tel
    ? `https://web.whatsapp.com/send?phone=${tel}&text=${texto}`
    : `https://web.whatsapp.com/send?text=${texto}`;
  window.open(url, '_blank');
  showToast('Abriendo WhatsApp Web…');
}

/** ---- Botón del facturador (factura actual) ---- */
function initWhatsAppModule() {
  const btn = document.getElementById('btn-whatsapp-invoice');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const number = document.getElementById('inv-number').value.trim();
    const fecha = document.getElementById('inv-date').value;
    const nombre = document.getElementById('inv-client-name').value.trim();
    const cif = document.getElementById('inv-client-cif').value.trim();
    const direccion = document.getElementById('inv-client-address').value.trim();
    const provincia = document.getElementById('inv-client-province').value.trim();
    const telefono = document.getElementById('inv-client-phone').value.trim();

    if (!number) { alert('Introduce el número de factura antes de enviarla.'); return; }
    if (activeInvoiceItems.length === 0) { alert('Añade al menos un producto antes de enviarla.'); return; }

    const factura = {
      number,
      date: fecha,
      clientName: nombre,
      clientCif: cif,
      clientAddress: direccion,
      clientProvince: provincia || 'Málaga',
      clientPhone: telefono,
      items: activeInvoiceItems,
      totalFactura: activeInvoiceItems.reduce((s, i) => s + i.subtotal, 0),
    };

    // Si ya está guardada en el registro, usar la guardada (tiene items confirmados)
    if (editingInvoiceId) {
      const guardada = await getInvoiceById(editingInvoiceId);
      if (guardada) {
        guardada.clientPhone = telefono || guardada.clientPhone;
        return enviarFacturaWhatsApp(guardada);
      }
    }
    enviarFacturaWhatsApp(factura);
  });
}

/** Cargo los datos del emisor para la cabecera del mensaje */
(async () => {
  try {
    window.__companyData = await getSetting('company_data', {});
  } catch (e) { window.__companyData = {}; }
})();
