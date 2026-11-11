/* ==========================================================================
   PESCADERÍA RANA - MODO MOSTRADOR Y ADMINISTRACIÓN
   --------------------------------------------------------------------------
   La app arranca en modo mostrador: sin Configuración y sin botones que
   puedan borrar o editar facturas. Para entrar hace falta un PIN, que se
   guarda como hash (nunca en claro). El desbloqueo dura lo que la pestaña
   abierta: al cerrar y volver a entrar, otra vez mostrador.
   También guarda una copia de seguridad automática al día y permite
   restaurarla.
   ========================================================================== */

const ADMIN_PIN_KEY = 'admin_pin_hash';
const ADMIN_SESION_KEY = 'admin_sesion';
const BACKUP_KEY = 'backup_auto';

let adminDesbloqueado = false;
let modoModalPin = 'entrar'; // 'entrar' | 'crear'

/** ¿Está abierta la administración? Lo consultan las tablas para sus botones */
function esAdmin() {
  return adminDesbloqueado;
}

/** Hash del PIN (SHA-256). Si el navegador no lo permite, se guarda marcado */
async function hashPin(pin) {
  const texto = 'pescaderia-rana:' + pin;
  if (window.crypto && crypto.subtle) {
    const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
    const hex = [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
    return 'sha256:' + hex;
  }
  return 'simple:' + pin;
}

function pinValido(pin) {
  return /^\d{4,8}$/.test(pin);
}

/** Aplica el modo (clase en el body) y refresca lo que depende de él */
async function aplicarModoAdmin() {
  document.body.classList.toggle('modo-admin', adminDesbloqueado);

  const boton = document.getElementById('admin-toggle');
  if (boton) {
    boton.classList.toggle('activo', adminDesbloqueado);
    const icono = boton.querySelector('i');
    const texto = boton.querySelector('span');
    if (icono) icono.className = adminDesbloqueado ? 'fa-solid fa-lock-open' : 'fa-solid fa-lock';
    if (texto) texto.textContent = adminDesbloqueado ? 'Salir de administración' : 'Administración';
    boton.title = adminDesbloqueado
      ? 'Volver al modo mostrador'
      : 'Entrar en administración con el PIN';
  }

  // Número y fecha: solo se pueden tocar dentro de administración
  const numero = document.getElementById('inv-number');
  const fecha = document.getElementById('inv-date');
  if (numero) numero.readOnly = !adminDesbloqueado;
  if (fecha) fecha.readOnly = !adminDesbloqueado;

  await refrescarListas();
  actualizarEstadoPin();
  mostrarEstadoCopia();
}

async function refrescarListas() {
  try {
    if (typeof loadInvoicesHistory === 'function') await loadInvoicesHistory();
  } catch (err) { /* sin datos todavía */ }
  try {
    if (typeof loadClients === 'function') await loadClients();
  } catch (err) { /* sin datos todavía */ }
  try {
    if (typeof renderSalesReport === 'function') await renderSalesReport();
  } catch (err) { /* sin datos todavía */ }
}

/* ---------------------------- PIN ---------------------------- */

async function abrirModalPin() {
  const guardado = await getSetting(ADMIN_PIN_KEY, null);
  modoModalPin = guardado ? 'entrar' : 'crear';

  const titulo = document.getElementById('admin-modal-title');
  const ayuda = document.getElementById('admin-modal-help');
  const boton = document.getElementById('btn-entrar-admin');
  if (titulo) titulo.textContent = modoModalPin === 'crear' ? 'Crear PIN de administración' : 'Entrar en administración';
  if (ayuda) {
    ayuda.textContent = modoModalPin === 'crear'
      ? 'Elige un PIN de 4 a 8 dígitos. Lo pedirá la app para entrar en Configuración o para borrar y editar facturas.'
      : 'Introduce el PIN para entrar en administración.';
  }
  if (boton) boton.textContent = modoModalPin === 'crear' ? 'Crear y entrar' : 'Entrar';

  const input = document.getElementById('admin-pin');
  const error = document.getElementById('admin-pin-error');
  if (input) input.value = '';
  if (error) error.classList.add('hidden');

  document.getElementById('admin-modal').classList.remove('hidden');
  if (input) setTimeout(() => input.focus(), 80);
}

function cerrarModalPin() {
  document.getElementById('admin-modal').classList.add('hidden');
  const input = document.getElementById('admin-pin');
  if (input) input.value = '';
}

async function confirmarPin() {
  const input = document.getElementById('admin-pin');
  const error = document.getElementById('admin-pin-error');
  const pin = (input ? input.value : '').trim();

  if (!pinValido(pin)) {
    if (error) { error.textContent = 'El PIN debe tener entre 4 y 8 números.'; error.classList.remove('hidden'); }
    return;
  }

  if (modoModalPin === 'crear') {
    await saveSetting(ADMIN_PIN_KEY, await hashPin(pin));
    adminDesbloqueado = true;
    sessionStorage.setItem(ADMIN_SESION_KEY, '1');
    cerrarModalPin();
    await aplicarModoAdmin();
    showToast('PIN creado: administración abierta');
    return;
  }

  const guardado = await getSetting(ADMIN_PIN_KEY, null);
  const intento = await hashPin(pin);
  if (guardado === intento) {
    adminDesbloqueado = true;
    sessionStorage.setItem(ADMIN_SESION_KEY, '1');
    cerrarModalPin();
    await aplicarModoAdmin();
    showToast('Administración abierta');
  } else {
    if (error) { error.textContent = 'PIN incorrecto.'; error.classList.remove('hidden'); }
    if (input) { input.value = ''; input.focus(); }
  }
}

function salirDeAdmin() {
  adminDesbloqueado = false;
  sessionStorage.removeItem(ADMIN_SESION_KEY);
  const inicio = document.querySelector('.nav-btn[data-tab="invoice-builder"]');
  if (inicio) inicio.click();
  aplicarModoAdmin();
  showToast('Administración cerrada');
}

async function actualizarEstadoPin() {
  const estado = document.getElementById('admin-pin-estado');
  if (!estado) return;
  const guardado = await getSetting(ADMIN_PIN_KEY, null);
  estado.textContent = guardado
    ? 'PIN activo: la app arranca en modo mostrador y pide el PIN para administrar.'
    : 'Sin PIN: ahora mismo cualquiera puede entrar en administración. Pon uno para bloquearla.';
}

async function guardarPinConfig() {
  const input = document.getElementById('cfg-admin-pin');
  const pin = (input ? input.value : '').trim();
  if (!pinValido(pin)) {
    showToast('El PIN debe tener entre 4 y 8 números', 'error');
    return;
  }
  await saveSetting(ADMIN_PIN_KEY, await hashPin(pin));
  if (input) input.value = '';
  await actualizarEstadoPin();
  showToast('PIN guardado');
}

async function quitarPin() {
  if (!confirm('¿Quitar el PIN? La app dejará de pedirlo para entrar en administración.')) return;
  await saveSetting(ADMIN_PIN_KEY, null);
  await actualizarEstadoPin();
  showToast('PIN eliminado');
}

/* --------------------- Copia de seguridad --------------------- */

async function crearCopiaSiToca() {
  try {
    const anterior = await getSetting(BACKUP_KEY, null);
    const hoy = new Date().toISOString().slice(0, 10);
    if (anterior && anterior.fecha === hoy) return;

    const facturas = await getAllInvoices();
    const clientes = await getAllClients();
    if (!facturas.length && !clientes.length) return;

    await saveSetting(BACKUP_KEY, {
      fecha: hoy,
      guardadoEn: new Date().toISOString(),
      clientes,
      facturas
    });
    mostrarEstadoCopia();
  } catch (err) {
    console.warn('No se pudo crear la copia automática:', err);
  }
}

function formatearFechaCopia(fecha) {
  if (!fecha) return '';
  const [a, m, d] = String(fecha).split('-');
  return d && m && a ? `${d}/${m}/${a}` : fecha;
}

async function mostrarEstadoCopia() {
  const estado = document.getElementById('backup-estado');
  if (!estado) return;
  const copia = await getSetting(BACKUP_KEY, null);
  if (!copia) {
    estado.textContent = 'Todavía no hay copia guardada. Se creará sola en cuanto haya facturas o clientes.';
    return;
  }
  const facturas = (copia.facturas || []).length;
  const clientes = (copia.clientes || []).length;
  estado.textContent = `Última copia: ${formatearFechaCopia(copia.fecha)} · ${facturas} factura(s) y ${clientes} cliente(s).`;
}

async function restaurarUltimaCopia() {
  const copia = await getSetting(BACKUP_KEY, null);
  if (!copia) {
    showToast('No hay ninguna copia guardada', 'error');
    return;
  }
  const facturas = (copia.facturas || []).length;
  const clientes = (copia.clientes || []).length;
  if (!confirm(`Se reemplazarán los datos actuales por la copia del ${formatearFechaCopia(copia.fecha)} (${facturas} facturas y ${clientes} clientes).\n\n¿Continuar?`)) return;

  try {
    await reemplazarDatos(copia.clientes || [], copia.facturas || []);
    await refrescarListas();
    mostrarEstadoCopia();
    showToast('Copia restaurada');
  } catch (err) {
    showToast('No se pudo restaurar: ' + err.message, 'error');
  }
}

async function restaurarDesdeArchivoArchivo(file) {
  let datos;
  try {
    datos = JSON.parse(await file.text());
  } catch (err) {
    showToast('El archivo no es una copia válida (JSON)', 'error');
    return;
  }
  const clientes = datos.clients || datos.clientes || [];
  const facturas = datos.invoices || datos.facturas || [];
  if (!Array.isArray(clientes) || !Array.isArray(facturas) || (!clientes.length && !facturas.length)) {
    showToast('Esa copia no trae facturas ni clientes reconocibles', 'error');
    return;
  }
  if (!confirm(`Se reemplazarán los datos actuales por los del archivo (${facturas.length} facturas y ${clientes.length} clientes).\n\n¿Continuar?`)) return;

  try {
    await reemplazarDatos(clientes, facturas);
    await refrescarListas();
    mostrarEstadoCopia();
    showToast('Datos restaurados desde el archivo');
  } catch (err) {
    showToast('No se pudo restaurar: ' + err.message, 'error');
  }
}

/* --------------------------- Arranque --------------------------- */

document.addEventListener('DOMContentLoaded', async () => {
  adminDesbloqueado = sessionStorage.getItem(ADMIN_SESION_KEY) === '1';

  const boton = document.getElementById('admin-toggle');
  if (boton) boton.addEventListener('click', () => (adminDesbloqueado ? salirDeAdmin() : abrirModalPin()));

  const entrar = document.getElementById('btn-entrar-admin');
  if (entrar) entrar.addEventListener('click', confirmarPin);

  const inputPin = document.getElementById('admin-pin');
  if (inputPin) {
    inputPin.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); confirmarPin(); }
    });
  }

  ['btn-cancelar-admin', 'btn-cerrar-admin'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', cerrarModalPin);
  });

  const guardarPin = document.getElementById('btn-guardar-pin');
  if (guardarPin) guardarPin.addEventListener('click', guardarPinConfig);

  const quitar = document.getElementById('btn-quitar-pin');
  if (quitar) quitar.addEventListener('click', quitarPin);

  const restaurar = document.getElementById('btn-restaurar-copia');
  if (restaurar) restaurar.addEventListener('click', restaurarUltimaCopia);

  const btnArchivo = document.getElementById('btn-restaurar-archivo');
  const inputArchivo = document.getElementById('input-restaurar-archivo');
  if (btnArchivo && inputArchivo) {
    btnArchivo.addEventListener('click', () => inputArchivo.click());
    inputArchivo.addEventListener('change', async () => {
      const file = inputArchivo.files && inputArchivo.files[0];
      if (file) await restaurarDesdeArchivoArchivo(file);
      inputArchivo.value = '';
    });
  }

  await aplicarModoAdmin();
  await crearCopiaSiToca();
});
