/* ==========================================================================
   PESCADERÍA RANA - IMPRESIÓN Y DESCARGA DE FACTURAS EN PDF
   ========================================================================== */

/**
 * Inicializa los controladores de impresión y PDF
 */
function initPDFModule() {
  const btnPrintInvoice = document.getElementById('btn-print-invoice');
  if (btnPrintInvoice) {
    btnPrintInvoice.addEventListener('click', () => {
      printOrDownloadInvoice();
    });
  }
}

/**
 * Lanza el cuadro de impresión nativo o genera el archivo PDF
 */
function printOrDownloadInvoice() {
  // Si html2pdf está disponible, dar opción o imprimir
  if (typeof html2pdf !== 'undefined') {
    const invNumber = document.getElementById('inv-number').value || 'SinNumero';
    const element = document.getElementById('invoice-print-area');

    const opt = {
      margin:       10,
      filename:     `Factura_Pescaderia_Rana_${invNumber}.pdf`,
      image:        { type: 'jpeg', quality: 0.98 },
      html2canvas:  { scale: 2, useCORS: true },
      jsPDF:        { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };

    showToast('Generando documento PDF oficial...');
    
    // Generar PDF y ofrecer impresión nativa como alternativa limpia
    html2pdf().set(opt).from(element).save().then(() => {
      showToast('PDF guardado en el dispositivo');
    }).catch(err => {
      console.warn('Fallback a impresión nativa del sistema:', err);
      window.print();
    });
  } else {
    window.print();
  }
}

/**
 * Imprime una factura directamente desde el historial de facturas
 */
async function printInvoiceFromHistory(id) {
  await editInvoiceInBuilder(id);
  setTimeout(() => {
    printOrDownloadInvoice();
  }, 300);
}
