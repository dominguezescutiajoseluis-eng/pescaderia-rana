/* ==========================================================================
   PESCADERÍA RANA - CONTROLADOR PRINCIPAL Y NAVEGACIÓN
   ========================================================================== */

document.addEventListener('DOMContentLoaded', async () => {
  // 1. Inicializar Base de Datos Local (sin datos de ejemplo)
  try {
    await initDB();
  } catch (err) {
    console.error('Error inicializando BD:', err);
  }

  // 2. Navegación por pestañas (Desktop & Mobile)
  initTabNavigation();

  // 3. Menú responsivo para móviles
  initMobileMenu();

  // 4. Inicializar Módulos de la App
  initClientsModule();
  initInvoicesModule();
  initPDFModule();
  initSettingsModule();
  initReportsModule();
  initWhatsAppModule();
  initExportarModule();
});

/**
 * Gestiona el cambio de pestañas de la interfaz
 */
function initTabNavigation() {
  const navBtns = document.querySelectorAll('.nav-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');

      navBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const activeSection = document.getElementById(targetTab);
      if (activeSection) {
        activeSection.classList.add('active');
      }

      // En móviles, cerrar la barra lateral si está abierta
      const sidebar = document.querySelector('.sidebar');
      if (sidebar && sidebar.classList.contains('open')) {
        sidebar.classList.remove('open');
      }
    });
  });
}

/**
 * Control del menú colapsable en dispositivos móviles
 */
function initMobileMenu() {
  const toggleBtn = document.getElementById('mobile-menu-toggle');
  const sidebar = document.querySelector('.sidebar');

  if (toggleBtn && sidebar) {
    toggleBtn.addEventListener('click', () => {
      sidebar.classList.toggle('open');
    });
  }
}

/**
 * Módulo de Ajustes y Configuración
 * Los datos del negocio NO están escritos en la página: se guardan aquí y se
 * pintan en la cabecera de la factura, el menú lateral y el título. Así la
 * misma app sirve para cualquier pescadería (y se puede configurar en otro PC
 * con un perfil exportable).
 */

/** Relación entre los campos del formulario y las claves guardadas */
const CAMPOS_NEGOCIO = {
  'cfg-company-name': 'companyName',
  'cfg-owner': 'owner',
  'cfg-nif': 'nif',
  'cfg-address': 'address',
  'cfg-postal': 'postalCode',
  'cfg-city': 'city',
  'cfg-province': 'province',
  'cfg-phone': 'phone',
  'cfg-email': 'email',
  'cfg-accent': 'accent'
};

/** Logotipo en uso (dataURL). Se fija al cargar la imagen o al importar perfil */
let logoActual = null;

/** Oscurece un color #rrggbb para el estado hover de los botones */
function oscurecerColor(hex, factor = 0.82) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const canales = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map(v => Math.round(v * factor).toString(16).padStart(2, '0'));
  return '#' + canales.join('');
}

/**
 * Pinta los datos del negocio en la interfaz y en la factura
 */
function aplicarDatosEmisor(datos = {}) {
  window.__companyData = datos;
  const pone = (id, valor) => {
    const el = document.getElementById(id);
    if (el) el.textContent = valor || '';
  };

  // Cabecera de la factura
  pone('pv-company-title', datos.companyName);
  pone('pv-company-owner', datos.owner);
  pone('pv-company-nif', datos.nif);
  pone('pv-company-address', datos.address);
  pone('pv-company-pc', datos.postalCode);
  pone('pv-company-city', datos.city);
  pone('pv-company-province-line', datos.province ? '(' + datos.province + ')' : '');
  pone('pv-company-phone', datos.phone);

  const email = document.getElementById('pv-company-email');
  if (email) {
    email.textContent = datos.email || '';
    email.classList.toggle('hidden', !datos.email);
  }

  const logoFactura = document.getElementById('pv-company-logo');
  if (logoFactura) {
    if (datos.logo) {
      logoFactura.src = datos.logo;
      logoFactura.classList.remove('hidden');
    } else {
      logoFactura.removeAttribute('src');
      logoFactura.classList.add('hidden');
    }
  }

  // Menú lateral y cabecera móvil
  pone('brand-name', datos.companyName);
  pone('mobile-brand-name', datos.companyName);

  const logoMarca = document.getElementById('brand-logo-img');
  const iconoMarca = document.getElementById('brand-logo-icon');
  if (logoMarca && iconoMarca) {
    if (datos.logo) {
      logoMarca.src = datos.logo;
      logoMarca.classList.remove('hidden');
      iconoMarca.classList.add('hidden');
    } else {
      logoMarca.removeAttribute('src');
      logoMarca.classList.add('hidden');
      iconoMarca.classList.remove('hidden');
    }
  }

  // Título de la pestaña
  document.title = (datos.companyName || 'Facturador') + ' - Trazabilidad y Facturación';

  // Color de marca (botones y acentos de la app)
  const color = /^#[0-9a-f]{6}$/i.test(datos.accent || '') ? datos.accent : '';
  if (color) {
    document.documentElement.style.setProperty('--primary-color', color);
    const hover = oscurecerColor(color);
    if (hover) document.documentElement.style.setProperty('--primary-hover', hover);
  }
}

/** Lee los campos del formulario del negocio */
function leerFormularioNegocio() {
  const datos = {};
  Object.entries(CAMPOS_NEGOCIO).forEach(([id, campo]) => {
    const el = document.getElementById(id);
    if (el) datos[campo] = el.value.trim();
  });
  if (logoActual) datos.logo = logoActual;
  return datos;
}

/** Rellena el formulario con los datos del negocio y actualiza el estado del logo */
function rellenarFormularioNegocio(datos = {}) {
  Object.entries(CAMPOS_NEGOCIO).forEach(([id, campo]) => {
    const el = document.getElementById(id);
    if (el && datos[campo] !== undefined && datos[campo] !== null) el.value = datos[campo];
  });
  logoActual = datos.logo || null;
  const estado = document.getElementById('cfg-logo-estado');
  if (estado) {
    estado.textContent = logoActual
      ? 'Logotipo cargado: sale en la factura y en el menú lateral.'
      : 'Sin logotipo: se usa el icono de pez de la app.';
  }
}

/** Reduce la imagen elegida (máx. 320 px de ancho) para guardar un dataURL ligero */
function leerLogoComoDataUrl(file, maxAncho = 320) {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onerror = () => reject(new Error('No se pudo leer la imagen.'));
    lector.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('El archivo no es una imagen válida.'));
      img.onload = () => {
        const escala = Math.min(1, maxAncho / (img.width || maxAncho));
        const lienzo = document.createElement('canvas');
        lienzo.width = Math.max(1, Math.round(img.width * escala));
        lienzo.height = Math.max(1, Math.round(img.height * escala));
        lienzo.getContext('2d').drawImage(img, 0, 0, lienzo.width, lienzo.height);
        resolve(lienzo.toDataURL('image/png'));
      };
      img.src = lector.result;
    };
    lector.readAsDataURL(file);
  });
}

/** Descarga el perfil del negocio para configurar otro ordenador */
async function exportarPerfilNegocio() {
  const datos = (await getSetting('company_data', null)) || leerFormularioNegocio();
  const perfil = {
    app: 'Perfil de negocio - Facturador Pescadería',
    exportedAt: new Date().toISOString(),
    company: datos
  };
  const nombre = 'perfil_' + String(datos.companyName || 'negocio')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') + '.json';

  const blob = new Blob([JSON.stringify(perfil, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  showToast('Perfil exportado: ' + nombre);
}

/** Aplica un perfil exportado desde otro equipo */
async function importarPerfilNegocio(file) {
  const texto = await file.text();
  let perfil;
  try {
    perfil = JSON.parse(texto);
  } catch (err) {
    throw new Error('El archivo no es un perfil válido (JSON).');
  }
  const datos = perfil && perfil.company ? perfil.company : perfil;
  if (!datos || !datos.companyName) {
    throw new Error('El perfil no trae los datos del negocio.');
  }
  await saveSetting('company_data', datos);
  rellenarFormularioNegocio(datos);
  aplicarDatosEmisor(datos);
  showToast('Perfil aplicado: ' + datos.companyName);
}

async function initSettingsModule() {
  const btnSaveCompany = document.getElementById('btn-save-company-cfg');
  const btnSaveKey = document.getElementById('btn-save-gemini-key');

  // 1) Datos del negocio: valores por defecto del formulario + lo ya guardado
  const porDefecto = {};
  Object.entries(CAMPOS_NEGOCIO).forEach(([id, campo]) => {
    const el = document.getElementById(id);
    if (el) porDefecto[campo] = el.value.trim();
  });

  const guardado = await getSetting('company_data', null);
  const datos = Object.assign({}, porDefecto, guardado || {});

  // Compatibilidad: versiones anteriores guardaban el CP y la ciudad dentro
  // de la dirección («Avda. Andalucia, local Nº 2 - 29750 Algarrobo Costa»).
  if (guardado && guardado.address && !guardado.postalCode) {
    const m = String(guardado.address).match(/^(.*?)[\s,-]*\b(\d{5})\b[\s,-]+(.+)$/);
    if (m) {
      datos.address = m[1].trim();
      datos.postalCode = m[2];
      datos.city = m[3].trim();
    }
  }

  rellenarFormularioNegocio(datos);
  aplicarDatosEmisor(datos);

  // 2) Logotipo: se previsualiza al elegirlo y se fija al guardar
  const inputLogo = document.getElementById('cfg-logo');
  if (inputLogo) {
    inputLogo.addEventListener('change', async () => {
      const file = inputLogo.files && inputLogo.files[0];
      if (!file) return;
      try {
        logoActual = await leerLogoComoDataUrl(file);
        aplicarDatosEmisor(leerFormularioNegocio());
        const estado = document.getElementById('cfg-logo-estado');
        if (estado) estado.textContent = 'Logotipo cargado: pulsa «Guardar» para fijarlo.';
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // 3) Perfil del negocio (exportar / importar)
  const btnExportProfile = document.getElementById('btn-export-profile');
  if (btnExportProfile) btnExportProfile.addEventListener('click', exportarPerfilNegocio);

  const btnImportProfile = document.getElementById('btn-import-profile');
  const inputPerfil = document.getElementById('cfg-import-profile-file');
  if (btnImportProfile && inputPerfil) {
    btnImportProfile.addEventListener('click', () => inputPerfil.click());
    inputPerfil.addEventListener('change', async () => {
      const file = inputPerfil.files && inputPerfil.files[0];
      if (!file) return;
      try {
        await importarPerfilNegocio(file);
      } catch (err) {
        showToast(err.message, 'error');
      }
      inputPerfil.value = '';
    });
  }

  if (btnSaveCompany) {
    btnSaveCompany.addEventListener('click', async () => {
      const nuevos = leerFormularioNegocio();
      await saveSetting('company_data', nuevos);
      aplicarDatosEmisor(nuevos);
      rellenarFormularioNegocio(nuevos);
      showToast('Datos del negocio guardados');
    });
  }

  // 4) Clave de la IA
  const geminiKey = await getSetting('gemini_api_key', '');
  if (geminiKey) {
    const inputKey = document.getElementById('cfg-gemini-key');
    if (inputKey) inputKey.value = geminiKey;
  }

  if (btnSaveKey) {
    btnSaveKey.addEventListener('click', async () => {
      const key = document.getElementById('cfg-gemini-key').value.trim();
      await saveSetting('gemini_api_key', key);
      showToast('Clave de la IA guardada correctamente');
    });
  }

}

/**
 * Notificación emergente Toast estilo Pescadería Rana
 */
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  const msgEl = document.getElementById('toast-message');
  const iconEl = document.getElementById('toast-icon');

  if (!toast || !msgEl) return;

  msgEl.textContent = message;
  
  if (type === 'error') {
    iconEl.className = 'fa-solid fa-circle-exclamation';
    iconEl.style.color = '#ef4444';
  } else {
    iconEl.className = 'fa-solid fa-circle-check';
    iconEl.style.color = '#10b981';
  }

  toast.classList.remove('hidden');

  setTimeout(() => {
    toast.classList.add('hidden');
  }, 3500);
}
