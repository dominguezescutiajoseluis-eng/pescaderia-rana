/* ==========================================================================
   PESCADERÍA RANA - RESUMEN DE VENTAS Y CÓMPUTO PERIÓDICO
   (En la web original este fichero faltaba — js/reports.js daba 404—;
    aquí está implementado con la misma interfaz.)
   ========================================================================== */

/**
 * Inicializa el módulo de informes
 */
function initReportsModule() {
  const periodSelect = document.getElementById('report-period-select');
  if (periodSelect) periodSelect.addEventListener('change', renderSalesReport);

  // Recalcular cada vez que se entra en la pestaña (así está siempre al día)
  const navBtn = document.querySelector('.nav-btn[data-tab="reports-summary"]');
  if (navBtn) navBtn.addEventListener('click', () => setTimeout(renderSalesReport, 80));

  renderSalesReport();
}

/**
 * Rango de fechas de cada período. Devuelve null para "todo el histórico".
 */
function reportRangeStart(period) {
  const ahora = new Date();
  const inicio = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
  switch (period) {
    case 'week': inicio.setDate(inicio.getDate() - 6); break;       // últimos 7 días
    case 'month': inicio.setDate(1); break;                          // este mes
    case 'quarter': inicio.setMonth(inicio.getMonth() - 3); break;   // últimos 3 meses
    case 'halfyear': inicio.setMonth(inicio.getMonth() - 6); break;  // últimos 6 meses
    case 'year': inicio.setMonth(0); inicio.setDate(1); break;       // este año
    case 'all': return null;
    default: inicio.setDate(1);
  }
  return inicio;
}

/**
 * Fecha efectiva de una factura (por su fecha de factura o, en su defecto, de alta)
 */
function fechaDeFactura(inv) {
  if (inv.date) return new Date(inv.date + 'T00:00:00');
  return new Date(inv.createdAt || 0);
}

/**
 * Rellena una tarjeta de período (total + nº de facturas)
 */
function pintarTarjetaPeriodo(totalId, countId, invoices, inicio) {
  const delPeriodo = invoices.filter(inv => !inicio || fechaDeFactura(inv) >= inicio);
  const total = delPeriodo.reduce((s, i) => s + (Number(i.totalFactura) || 0), 0);
  const totalEl = document.getElementById(totalId);
  const countEl = document.getElementById(countId);
  if (totalEl) totalEl.textContent = formatNumber(total) + ' €';
  if (countEl) countEl.textContent = delPeriodo.length + (delPeriodo.length === 1 ? ' factura' : ' facturas');
}

/**
 * Recalcula tarjetas y desglose por cliente
 */
async function renderSalesReport() {
  let invoices = [];
  try {
    invoices = await getAllInvoices();
  } catch (err) {
    console.error('Error leyendo facturas para el resumen:', err);
  }

  const periodSelect = document.getElementById('report-period-select');
  const periodo = periodSelect ? periodSelect.value : 'month';

  // Tarjetas fijas de la cabecera (cada una con su período)
  pintarTarjetaPeriodo('report-week-total', 'report-week-count', invoices, reportRangeStart('week'));
  pintarTarjetaPeriodo('report-month-total', 'report-month-count', invoices, reportRangeStart('month'));
  pintarTarjetaPeriodo('report-quarter-total', 'report-quarter-count', invoices, reportRangeStart('quarter'));
  pintarTarjetaPeriodo('report-halfyear-total', 'report-halfyear-count', invoices, reportRangeStart('halfyear'));
  pintarTarjetaPeriodo('report-year-total', 'report-year-count', invoices, reportRangeStart('year'));

  // Desglose por cliente en el período elegido
  const inicio = reportRangeStart(periodo);
  const delPeriodo = invoices.filter(inv => !inicio || fechaDeFactura(inv) >= inicio);

  const porCliente = {};
  delPeriodo.forEach(inv => {
    const nombre = inv.clientName || 'Cliente Ocasional';
    const clave = nombre + '|' + (inv.clientCif || '');
    if (!porCliente[clave]) {
      porCliente[clave] = { nombre, cif: inv.clientCif || '-', n: 0, total: 0 };
    }
    porCliente[clave].n += 1;
    porCliente[clave].total += Number(inv.totalFactura) || 0;
  });

  const filas = Object.values(porCliente).sort((a, b) => b.total - a.total);
  const tbody = document.getElementById('report-client-breakdown-body');
  if (!tbody) return;

  if (filas.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align: center; color: #64748b; padding: 2rem;">
          No hay facturas en el período seleccionado.
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = filas.map(f => `
    <tr>
      <td><strong>${escapeHtml(f.nombre)}</strong></td>
      <td>${escapeHtml(f.cif)}</td>
      <td>${f.n}</td>
      <td><strong>${formatNumber(f.total)} €</strong></td>
    </tr>`).join('');
}
