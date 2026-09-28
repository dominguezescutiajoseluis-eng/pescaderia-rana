/**
 * Pescadería Rana — Facturador: autoprueba del envoltorio de escritorio.
 *
 * Arranca la aplicación real (main.js), espera a que cargue y comprueba:
 *   1) la app se sirve por el servidor interno (cero peticiones a internet)
 *   2) la base de datos local (IndexedDB) guarda y lee clientes y facturas
 *   3) el OCR local (Tesseract empaquetado) lee una papeleta dibujada al vuelo
 *   4) el flujo completo: añadir producto → guardar factura → Resumen de Ventas
 *
 * Uso:  node_modules/.bin/electron --user-data-dir=<carpeta> prueba-escritorio.js
 */

const { app } = require('electron');

require('./main.js');

const peticionesExternas = [];
let terminado = false;

const GUION = `(async () => {
  const esperar = (ms) => new Promise(r => setTimeout(r, ms));
  if (document.readyState !== 'complete') await esperar(2500);
  await esperar(600);
  const salida = {};

  salida.protocolo = location.protocol;
  salida.titulo = document.title;
  salida.escritorio = !!window.ES_ESCRITORIO;

  // La app de escritorio no debe registrar service worker
  const registroSw = await navigator.serviceWorker.getRegistration();
  salida.serviceWorker = registroSw ? 'registrado' : 'ninguno';

  // El generador de PDF va empaquetado
  salida.html2pdf = typeof html2pdf !== 'undefined';

  // Puente móvil: botón 📱 y librería QR presentes en escritorio
  const btnMovil = document.getElementById('btn-lote-movil');
  salida.botonMovil = !!btnMovil && !btnMovil.classList.contains('hidden');
  salida.qrcodeLib = typeof qrcode !== 'undefined';

  // ---- IndexedDB: alta y lectura de un cliente ----
  await saveClient({ name: 'Cliente Autoprueba', cif: 'B-00000000', address: 'Calle Prueba 1', province: 'Málaga', phone: '600 000 000' });
  const clientes = await getAllClients();
  salida.clientes = clientes.length;
  salida.clienteOk = clientes.some(c => c.name === 'Cliente Autoprueba');

  // ---- OCR del lote con una papeleta dibujada al vuelo ----
  const canvas = document.createElement('canvas');
  canvas.width = 1000; canvas.height = 600;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  ctx.font = 'bold 44px Arial';
  ctx.fillText('LONJA DE ALGARROBO', 50, 90);
  ctx.font = '40px Arial';
  ctx.fillText('Lote: L-4521', 50, 200);
  ctx.fillText('Dorada  5,40 kg  8,90', 50, 300);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.95));
  const fichero = new File([blob], 'papeleta.jpg', { type: 'image/jpeg' });
  const t0 = Date.now();
  await leerYRellenarLote(fichero);
  salida.ocrSegundos = Math.round((Date.now() - t0) / 100) / 10;
  salida.loteLeido = document.getElementById('item-lote').value;
  salida.loteOk = /4521/.test(salida.loteLeido);

  // ---- Flujo de factura: añadir producto y guardar ----
  document.getElementById('item-concept').value = 'Dorada';
  document.getElementById('item-qty').value = '5.4';
  document.getElementById('item-price').value = '8.9';
  handleAddItemFromForm();
  salida.itemsEnFactura = activeInvoiceItems.length;
  salida.totalVista = document.getElementById('pv-total-factura').textContent;

  const facturasAntes = (await getAllInvoices()).length;
  await handleSaveInvoice();
  const facturas = await getAllInvoices();
  salida.facturasNuevas = facturas.length - facturasAntes;
  salida.factura = facturas.length ? { numero: facturas[0].number, total: facturas[0].totalFactura } : null;
  salida.filasHistorial = document.querySelectorAll('#invoices-table-body tr').length;

  // ---- Resumen de ventas (reports.js) ----
  await renderSalesReport();
  salida.resumenMes = document.getElementById('report-month-total').textContent;
  salida.resumenMesFacturas = document.getElementById('report-month-count').textContent;
  salida.filasDesglose = document.querySelectorAll('#report-client-breakdown-body tr').length;

  // Limpieza: la autoprueba no debe dejar datos
  for (const inv of facturas) await deleteInvoice(inv.id);
  for (const c of clientes) await deleteClient(c.id);
  salida.limpiezaOk = (await getAllInvoices()).length === 0 && (await getAllClients()).length === 0;

  return salida;
})()`;

app.on('browser-window-created', (event, ventana) => {
    ventana.webContents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (detalles, callback) => {
        if (!/^http:\/\/127\.0\.0\.1:\d+\/|^devtools:|^blob:|^data:/.test(detalles.url)) peticionesExternas.push(detalles.url);
        callback({});
    });

    ventana.webContents.on('did-fail-load', (e, code, desc, url) => {
        console.error('FALLO DE CARGA:', code, desc, url);
    });
    ventana.webContents.on('console-message', (e, nivel, mensaje, linea, fuente) => {
        if (nivel >= 2) console.error('CONSOLA:', mensaje, '(', fuente, linea, ')');
    });

    ventana.webContents.on('did-finish-load', async () => {
        if (terminado) return;
        terminado = true;
        await new Promise(r => setTimeout(r, 400));
        const salida = { peticionesExternas };
        try {
            Object.assign(salida, await ventana.webContents.executeJavaScript(GUION));
        } catch (err) {
            salida.error = err.message;
        }
        const ok = !salida.error
            && salida.protocolo === 'http:'
            && peticionesExternas.length === 0
            && salida.escritorio === true
            && salida.serviceWorker === 'ninguno'
            && salida.html2pdf === true
            && salida.botonMovil === true
            && salida.qrcodeLib === true
            && salida.clienteOk === true
            && salida.loteOk === true
            && salida.itemsEnFactura === 1
            && salida.facturasNuevas === 1
            && salida.filasHistorial >= 1
            && salida.filasDesglose >= 1
            && salida.limpiezaOk === true;
        console.log('\n──── Autoprueba del Facturador ────');
        console.log(JSON.stringify(salida, null, 1));
        console.log(ok ? '\n✅ AUTOPRUEBA CORRECTA' : '\n❌ AUTOPRUEBA CON FALLOS');
        app.exit(ok ? 0 : 1);
    });
});

setTimeout(() => {
    if (!terminado) {
        console.error('❌ La ventana no llegó a cargar en 60 s');
        app.exit(1);
    }
}, 60000);
