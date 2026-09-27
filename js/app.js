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
 */
async function initSettingsModule() {
  const btnSaveCompany = document.getElementById('btn-save-company-cfg');
  const btnSaveKey = document.getElementById('btn-save-gemini-key');

  // Cargar clave guardada
  const geminiKey = await getSetting('gemini_api_key', '');
  if (geminiKey) {
    document.getElementById('cfg-gemini-key').value = geminiKey;
  }

  if (btnSaveCompany) {
    btnSaveCompany.addEventListener('click', async () => {
      const companyName = document.getElementById('cfg-company-name').value;
      const owner = document.getElementById('cfg-owner').value;
      const nif = document.getElementById('cfg-nif').value;
      const address = document.getElementById('cfg-address').value;
      const phone = document.getElementById('cfg-phone').value;

      await saveSetting('company_data', { companyName, owner, nif, address, phone });
      showToast('Datos de Pescadería Rana actualizados');
    });
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
