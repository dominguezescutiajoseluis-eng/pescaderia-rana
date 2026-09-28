/**
 * Pescadería Rana — aplicación de escritorio (Electron)
 *
 * Sirve la misma app web (index.html, js/, vendor/) desde un servidor interno
 * escuchando SOLO en 127.0.0.1, y la abre en una ventana propia.
 *
 * ¿Por qué un servidor local y no file://? Porque así son posibles el
 * almacenamiento persistente, la cámara y el worker del motor OCR, igual que
 * en el navegador, pero sin necesitar internet en ningún momento.
 */

const { app, BrowserWindow, Menu, shell, session, ipcMain } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { iniciarPuente, VIDA_SESION_MS } = require('./puente');

/** Carpeta que contiene index.html. En desarrollo es la padre de escritorio/;
 *  en el .deb instalado este main.js vive YA en resources/app, junto a la web.
 *  Se comprueba de verdad: si no, el servidor daría 404 y la ventana saldría
 *  vacía (azul) sin explicación aparente. */
function localizarRaizApp() {
    const candidatos = [__dirname, path.resolve(__dirname, '..')];
    for (const c of candidatos) {
        if (fs.existsSync(path.join(c, 'index.html'))) return c;
    }
    console.error('No encuentro index.html junto a', __dirname);
    return path.resolve(__dirname, '..');
}
const APP_ROOT = localizarRaizApp();
const PUERTOS = [8765, 8766, 8767, 8768, 8769, 8770, 8771, 8772];

const TIPOS_MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.gz': 'application/gzip',
    '.md': 'text/markdown; charset=utf-8',
};

let servidor = null;
let origen = '';

// MODO KIOSKO: se activa arrancando la app con --kiosko (lo usa el arranque
// automático del ordenador de la pescadería). Pantalla completa, sin barra
// de título ni menú visible. Salidas de emergencia con teclado:
//   Ctrl+Alt+K → entrar/salir del kiosco
//   Ctrl+Alt+Q → cerrar la aplicación
const KIOSKO = process.argv.includes('--kiosko');

/* ---------- PUENTE MÓVIL: la cámara del móvil como escáner del PC ---------- */
let puente = null;          // { url, cerrar }
let puenteTemporizador = null;
let ventanaPrincipal = null;

/** Abre el puente (o devuelve el existente) y da la URL para el QR */
async function puenteIniciar() {
    if (puente) return { url: puente.url };
    const p = await iniciarPuente();
    puente = p;
    // La sesión del puente caduca: nadie debería dejar el QR abierto horas
    puenteTemporizador = setTimeout(() => {
        if (puente) {
            puente.cerrar();
            puente = null;
            console.log('Puente móvil cerrado por tiempo (15 min). Se reabre al pulsar el botón otra vez.');
        }
    }, VIDA_SESION_MS);
    return { url: p.url };
}

function puenteCerrar() {
    if (puenteTemporizador) clearTimeout(puenteTemporizador);
    puenteTemporizador = null;
    if (puente) {
        puente.cerrar();
        puente = null;
    }
}

/** La foto llega del móvil (proceso principal) y se pasa a la página */
function puenteReenviarFoto(dataUrl) {
    if (ventanaPrincipal && !ventanaPrincipal.isDestroyed()) {
        ventanaPrincipal.webContents.send('puente-foto', dataUrl);
    }
}
process.on('puente-foto', puenteReenviarFoto);

function crearServidor() {
    const srv = http.createServer((req, res) => {
        try {
            const ruta = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
            const relativa = ruta === '/' || ruta === '' ? '/index.html' : ruta;
            const fichero = path.normalize(path.join(APP_ROOT, relativa));
            if (!fichero.startsWith(APP_ROOT)) {
                res.writeHead(403, { 'Content-Type': 'text/plain' });
                return res.end('Prohibido');
            }
            fs.readFile(fichero, (err, datos) => {
                if (err) {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    return res.end('No encontrado');
                }
                const tipo = TIPOS_MIME[path.extname(fichero).toLowerCase()] || 'application/octet-stream';
                res.writeHead(200, {
                    'Content-Type': tipo,
                    'Content-Length': datos.length,
                    'Cache-Control': 'no-store',
                });
                res.end(datos);
            });
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Error interno');
        }
    });

    return new Promise((resolve, reject) => {
        let intento = 0;
        const probar = () => {
            if (intento >= PUERTOS.length) {
                reject(new Error('No hay ningún puerto libre para el servidor interno'));
                return;
            }
            const puerto = PUERTOS[intento++];
            srv.removeAllListeners('error');
            srv.once('error', (err) => {
                if (err.code === 'EADDRINUSE') probar();
                else reject(err);
            });
            srv.listen(puerto, '127.0.0.1', () => {
                srv.removeAllListeners('error');
                srv.on('error', (err) => console.error('Servidor interno:', err.message));
                servidor = srv;
                resolve(puerto);
            });
        };
        probar();
    });
}

/**
 * Borra el service worker que hubiera guardado una versión anterior de la app.
 * Sin esto, un perfil antiguo podría seguir sirviendo ficheros viejos desde su
 * caché (y en Electron 44 el simple hecho de actualizarlo tumbaba la ventana).
 * Solo se toca esta carpeta: los datos (Local Storage) no se tocan.
 */
function limpiarServiceWorkerAntiguo() {
    try {
        const carpeta = path.join(app.getPath('userData'), 'Service Worker');
        if (fs.existsSync(carpeta)) {
            fs.rmSync(carpeta, { recursive: true, force: true });
            console.log('Service worker antiguo eliminado del perfil');
        }
    } catch (err) {
        console.error('No se pudo limpiar el service worker antiguo:', err.message);
    }
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 840,
        minWidth: 940,
        minHeight: 620,
        title: 'Pescadería Rana — Facturador',
        backgroundColor: '#0b4a6f',
        show: false,
        kiosk: KIOSKO,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            spellcheck: false,
            backgroundThrottling: false,
        },
    });

    win.once('ready-to-show', () => {
        win.show();
        if (KIOSKO) {
            win.setKiosk(true);
            console.log('Modo KIOSKO activo (Ctrl+Alt+K para salir, Ctrl+Alt+Q para cerrar)');
        }
    });

    // Atajos de emergencia del kiosco (funcionan aunque el menú no se vea)
    win.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown' || !input.control || !input.alt) return;
        const tecla = (input.key || '').toLowerCase();
        if (tecla === 'q') {
            event.preventDefault();
            app.quit();
        } else if (tecla === 'k') {
            event.preventDefault();
            win.setKiosk(!win.isKiosk());
        }
    });
    win.webContents.on('render-process-gone', (_e, detalles) => {
        console.error('Proceso de render terminado:', detalles.reason);
        if (!win.isDestroyed() && reiniciosRender < 3) {
            reiniciosRender += 1;
            setTimeout(() => { try { win.webContents.reload(); } catch (e) { /* ventana ya cerrada */ } }, 600);
        }
    });
    ventanaPrincipal = win;
    win.on('closed', () => { if (ventanaPrincipal === win) ventanaPrincipal = null; });

    // Los enlaces externos (wa.me / WhatsApp Web) se abren en el navegador del
    // sistema, que es donde el cliente tiene la sesión de WhatsApp iniciada.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });

    win.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith(origen)) {
            event.preventDefault();
            if (/^https?:/i.test(url)) shell.openExternal(url);
        }
    });

    win.loadURL(origen + '/index.html');
    return win;
}

function buildMenu() {
    const plantilla = [
        { label: 'Archivo', submenu: [{ role: 'quit', label: 'Salir' }] },
        {
            label: 'Edición',
            submenu: [
                { role: 'undo', label: 'Deshacer' },
                { role: 'redo', label: 'Rehacer' },
                { type: 'separator' },
                { role: 'cut', label: 'Cortar' },
                { role: 'copy', label: 'Copiar' },
                { role: 'paste', label: 'Pegar' },
                { role: 'selectAll', label: 'Seleccionar todo' },
            ],
        },
        {
            label: 'Ver',
            submenu: [
                { role: 'reload', label: 'Recargar' },
                { role: 'forceReload', label: 'Recargar sin caché' },
                { type: 'separator' },
                { role: 'resetZoom', label: 'Zoom normal' },
                { role: 'zoomIn', label: 'Aumentar zoom' },
                { role: 'zoomOut', label: 'Reducir zoom' },
                { type: 'separator' },
                { role: 'togglefullscreen', label: 'Pantalla completa' },
                {
                    label: 'Modo kiosco (Ctrl+Alt+K)',
                    accelerator: 'Ctrl+Alt+K',
                    click: () => {
                        const w = BrowserWindow.getAllWindows()[0];
                        if (w) w.setKiosk(!w.isKiosk());
                    },
                },
                { role: 'toggleDevTools', label: 'Herramientas de desarrollo' },
            ],
        },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(plantilla));
}

app.setName('Pescadería Rana — Facturador');

// GPUs antiguas (Intel GMA de portátiles viejos, p. ej. eMachines E525):
// el proceso de GPU de Chromium muere al arrancar ("Could not create a backing
// OpenGL context", "GPU process isn't usable. Goodbye") y la ventana queda en
// azul vacío. Esta app no necesita GPU (el OCR es CPU/WASM), así que se
// prohíbe por completo: ni aceleración ni proceso de GPU ni compositado GPU.
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('in-process-gpu');        // ni proceso de GPU aparte
app.commandLine.appendSwitch('use-angle', 'swiftshader'); // si algo pide GL: software
app.disableHardwareAcceleration();

// Si el proceso de render se cae (por lo que sea), recargar la ventana sola
let reiniciosRender = 0;

// Una sola instancia: así el puerto y los datos son siempre los mismos
const instanciaUnica = app.requestSingleInstanceLock();
if (!instanciaUnica) {
    app.quit();
} else {
    app.on('second-instance', () => {
        const ventana = BrowserWindow.getAllWindows()[0];
        if (ventana) {
            if (ventana.isMinimized()) ventana.restore();
            ventana.focus();
        }
    });

    app.whenReady().then(async () => {
        limpiarServiceWorkerAntiguo();

        // La cámara (escáner de papeletas) necesita permiso explícito
        session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
            const permitidos = ['media', 'fullscreen', 'clipboard-sanitized-write'];
            callback(permitidos.includes(permission));
        });

        // Canal para el puente del móvil (QR → foto → OCR)
        ipcMain.handle('puente-movil-iniciar', () => puenteIniciar());

        // Clave de IA de fábrica: el render la pide y se la doy UNA vez
        ipcMain.handle('clave-ia-fabrica', () => {
            const k = global.__geminiKeyPendiente || null;
            global.__geminiKeyPendiente = null;
            return k;
        });

        bootstrapClaveIA();

        try {
            const puerto = await crearServidor();
            origen = `http://127.0.0.1:${puerto}`;
            console.log('Pescadería Rana escuchando en', origen);
        } catch (err) {
            console.error('No se pudo iniciar el servidor interno:', err.message);
            app.quit();
            return;
        }

        buildMenu();
        createWindow();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });

    app.on('will-quit', () => {
        puenteCerrar();
        if (servidor) servidor.close();
    });
}

app.on('window-all-closed', () => app.quit());

/**
 * Instalación automática de la CLAVE DE GEMINI: si en la carpeta de la app
 * hay un fichero gemini-key.txt (primera línea = la clave), se copia a la
 * configuración de la app UNA SOLA VEZ (el txt se renombra a .instalada para
 * que no vuelva a importarse ni viaje en actualizaciones).
 * Así se puede dejar la IA configurada de fábrica sin tocar la interfaz.
 */
function bootstrapClaveIA() {
    try {
        const claveTxt = path.join(APP_ROOT, 'gemini-key.txt');
        const instalada = claveTxt + '.instalada';
        if (!fs.existsSync(claveTxt)) return;
        const primeraLinea = fs.readFileSync(claveTxt, 'utf8')
            .split(/\r?\n/).map(l => l.trim()).find(l => l.length > 20) || '';
        if (!primeraLinea) return;
        fs.renameSync(claveTxt, instalada); // marca "ya instalada"
        console.log('gemini-key.txt detectada: la app la importará en su primer uso');
        global.__geminiKeyPendiente = primeraLinea;
    } catch (err) {
        console.error('bootstrap clave IA:', err.message);
    }
}
