#!/usr/bin/env node
/**
 * Pescadería Rana — constructor del paquete .deb (Linux)
 *
 * No necesita ni npm, ni dpkg, ni zip: descarga el Electron Linux oficial,
 * monta el árbol de la aplicación y escribe control.tar.gz + data.tar.gz + ar
 * con código propio. Funciona igual en Windows, macOS y Linux.
 *
 * Uso:
 *   node construir-deb.js                 # construye dist/pescaderia-rana-facturador_1.0.0_amd64.deb
 *   node construir-deb.js --arch=arm64    # variante ARM de 64 bits
 *   node construir-deb.js --solo-verificar
 *   node construir-deb.js --reusar        # reutiliza el Electron ya descomprimido
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const zlib = require('node:zlib');

// ---------------- Configuración ----------------
const PKG = require('./package.json');
const VERSION = PKG.version;
const ROOT = path.resolve(__dirname, '..');            // carpeta de la app (pescaderia/)
const WORKSPACE = path.resolve(ROOT, '..');            // raíz del proyecto
const BUILD = path.join(__dirname, '.build');
const CACHE = path.join(BUILD, 'cache');
const OUT_DIR = path.join(WORKSPACE, 'dist');
const DEPENDENCIAS = [
    'libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6',
    'xdg-utils', 'libatspi2.0-0', 'libdrm2', 'libgbm1',
    'libasound2 | libasound2t64', 'libcups2', 'libpulse0',
];
const EXCLUIR = new Set(['escritorio', '.git', 'node_modules', '.build', 'dist', '.freebuff',
    // NUNCA viajar dentro del paquete: la clave se pone a mano en cada PC
    'gemini-key.txt', 'gemini-key.txt.instalada']);
// Permisos dentro del paquete: el binario y el ayudante de sandbox deben ser ejecutables
// (chrome-sandbox además setuid, como en cualquier paquete de Electron para Linux)
const EJECUTABLES = new Set([
    'opt/pescaderia-rana-facturador/pescaderia-rana-facturador',
    'opt/pescaderia-rana-facturador/chrome_crashpad_handler',
    'usr/bin/pescaderia-rana-facturador',
]);
const SETUID = new Set(['opt/pescaderia-rana-facturador/chrome-sandbox']);
const ELECTRON_VERSION = (process.env.ELECTRON_VERSION || (PKG.devDependencies && PKG.devDependencies.electron) || '44.4.5').replace(/[^0-9.]/g, '');

const args = process.argv.slice(2);
const TARGET_ARCH = (args.find((a) => a.startsWith('--arch=')) || '--arch=amd64').split('=')[1];
const ELECTRON_ARCH = TARGET_ARCH === 'arm64' ? 'arm64' : 'x64';
const SOLO_VERIFICAR = args.includes('--solo-verificar');
const REUSAR = args.includes('--reusar');
const DEB_NAME = `pescaderia-rana-facturador_${VERSION}_${TARGET_ARCH}.deb`;
const DEB_PATH = path.join(OUT_DIR, DEB_NAME);
const STAGE = path.join(BUILD, 'stage');
const ELECTRON_DIR = path.join(BUILD, `electron-v${ELECTRON_VERSION}-linux-${ELECTRON_ARCH}`);

const log = (...a) => console.log('›', ...a);
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

// ---------------- Utilidades de ficheros ----------------
function rmrf(p) {
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function escribir(stream, buf) {
    return new Promise((resolve, reject) => {
        const alFallar = (err) => reject(err);
        const alTerminar = () => {
            stream.removeListener('error', alFallar);
            resolve();
        };
        stream.once('error', alFallar);
        if (stream.write(buf)) alTerminar();
        else stream.once('drain', alTerminar);
    });
}

function volcarFichero(ruta, stream) {
    return new Promise((resolve, reject) => {
        const rs = fs.createReadStream(ruta);
        rs.on('error', reject);
        rs.on('end', resolve);
        rs.pipe(stream, { end: false });
    });
}

function copiarArbol(src, dest, excluir) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entrada of fs.readdirSync(src, { withFileTypes: true })) {
        if (excluir.has(entrada.name) || entrada.name.endsWith('.deb')) continue;
        const origen = path.join(src, entrada.name);
        const destino = path.join(dest, entrada.name);
        if (entrada.isDirectory()) {
            copiarArbol(origen, destino, excluir);
        } else {
            fs.copyFileSync(origen, destino);
        }
    }
}

// Electron trae 55 idiomas (~8,7 MB). La app solo habla español: se dejan
// los de español e inglés (Chromium necesita al menos uno al que recurrir).
function recortarIdiomas(optDir) {
    const dirLocales = path.join(optDir, 'locales');
    if (!fs.existsSync(dirLocales)) return;
    const conservar = new Set(['es.pak', 'es-419.pak', 'en-US.pak', 'en-GB.pak', 'en.pak']);
    let quitados = 0;
    let bytes = 0;
    for (const fichero of fs.readdirSync(dirLocales)) {
        if (conservar.has(fichero)) continue;
        const ruta = path.join(dirLocales, fichero);
        bytes += fs.statSync(ruta).size;
        fs.rmSync(ruta);
        quitados++;
    }
    log(`idiomas del paquete: ${quitados} ficheros quitados (${mb(bytes)} menos)`);
}

// ---------------- Descarga ----------------
function descargar(url, destino, saltos = 0) {
    return new Promise((resolve, reject) => {
        if (saltos > 6) return reject(new Error('Demasiadas redirecciones'));
        https.get(url, { headers: { 'User-Agent': 'pescaderia-rana-facturador-build' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return resolve(descargar(res.headers.location, destino, saltos + 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} al descargar ${url}`));
            }
            const total = Number(res.headers['content-length'] || 0);
            let recibido = 0;
            let ultimoAviso = 0;
            fs.mkdirSync(path.dirname(destino), { recursive: true });
            const out = fs.createWriteStream(destino);
            res.on('data', (chunk) => {
                recibido += chunk.length;
                if (total && recibido - ultimoAviso > 10 * 1024 * 1024) {
                    ultimoAviso = recibido;
                    log(`descargando… ${mb(recibido)} de ${mb(total)}`);
                }
            });
            res.pipe(out);
            out.on('finish', () => resolve(destino));
            out.on('error', reject);
        }).on('error', reject);
    });
}

// ---------------- ZIP (lector propio) ----------------
function descomprimirZip(zipPath, destDir) {
    const size = fs.statSync(zipPath).size;
    const fd = fs.openSync(zipPath, 'r');
    const tailLen = Math.min(size, 70000);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP: no se encontró el final del directorio central');

    let entryCount = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);

    // Soporte mínimo de ZIP64
    if (entryCount === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
        for (let i = tail.length - 20; i >= 0; i--) {
            if (tail.readUInt32LE(i) === 0x06064b50) { // zip64 EOCD
                entryCount = Number(tail.readBigUInt64LE(i + 32));
                cdSize = Number(tail.readBigUInt64LE(i + 40));
                cdOffset = Number(tail.readBigUInt64LE(i + 48));
                break;
            }
        }
    }

    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);

    let p = 0;
    let extraidos = 0;
    for (let i = 0; i < entryCount && p + 46 <= cd.length; i++) {
        if (cd.readUInt32LE(p) !== 0x02014b50) break;
        const metodo = cd.readUInt16LE(p + 10);
        const compSize = cd.readUInt32LE(p + 20);
        const nameLen = cd.readUInt16LE(p + 28);
        const extraLen = cd.readUInt16LE(p + 30);
        const commentLen = cd.readUInt16LE(p + 32);
        const atributos = cd.readUInt32LE(p + 38);
        const localOffset = cd.readUInt32LE(p + 42);
        const nombre = cd.toString('utf8', p + 46, p + 46 + nameLen);
        p += 46 + nameLen + extraLen + commentLen;

        const lh = Buffer.alloc(30);
        fs.readSync(fd, lh, 0, 30, localOffset);
        const datosDesde = localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);

        const salida = path.join(destDir, nombre);
        if (nombre.endsWith('/')) {
            fs.mkdirSync(salida, { recursive: true });
            continue;
        }
        const comprimido = Buffer.alloc(compSize);
        fs.readSync(fd, comprimido, 0, compSize, datosDesde);
        const datos = metodo === 0 ? comprimido : zlib.inflateRawSync(comprimido);
        fs.mkdirSync(path.dirname(salida), { recursive: true });
        fs.writeFileSync(salida, datos);
        const modo = (atributos >>> 16) & 0o7777;
        if (modo) fs.chmodSync(salida, modo);
        extraidos++;
    }
    fs.closeSync(fd);
    log(`descomprimidos ${extraidos} archivos de Electron`);
}

// ---------------- TAR ----------------
function cabeceraTar(nombre, modo, size, tipo, mtimeSeg) {
    const buf = Buffer.alloc(512);
    let corto = nombre;
    let prefijo = '';
    if (Buffer.byteLength(nombre) > 100) {
        const idx = nombre.lastIndexOf('/', nombre.length - 101);
        if (idx > 0 && Buffer.byteLength(nombre.slice(0, idx)) <= 155) {
            prefijo = nombre.slice(0, idx);
            corto = nombre.slice(idx + 1);
        }
    }
    buf.write(corto, 0, 100, 'utf8');
    buf.write(modo.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
    buf.write('0000000\0', 108, 8, 'ascii');
    buf.write('0000000\0', 116, 8, 'ascii');
    buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    buf.write(Math.floor(mtimeSeg).toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii');
    buf.write('        ', 148, 8, 'ascii');
    buf.write(tipo, 156, 1, 'ascii');
    buf.write('ustar\0', 257, 6, 'ascii');
    buf.write('00', 263, 2, 'ascii');
    buf.write('root', 265, 32, 'ascii');
    buf.write('root', 297, 32, 'ascii');
    if (prefijo) buf.write(prefijo, 345, 155, 'utf8');
    let suma = 0;
    for (let i = 0; i < 512; i++) suma += buf[i];
    buf.write(suma.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    return buf;
}

async function escribirTarGz(entradas, destino) {
    const gzip = zlib.createGzip({ level: 6 });
    const out = fs.createWriteStream(destino);
    gzip.pipe(out);
    const ahora = Math.floor(Date.now() / 1000);

    for (const e of entradas) {
        if (e.tipo === '5') {
            await escribir(gzip, cabeceraTar('./' + e.ruta + '/', e.modo || 0o755, 0, '5', ahora));
            continue;
        }
        const size = e.datos ? e.datos.length : fs.statSync(e.origen).size;
        await escribir(gzip, cabeceraTar('./' + e.ruta, e.modo || 0o644, size, '0', ahora));
        if (e.datos) await escribir(gzip, e.datos);
        else await volcarFichero(e.origen, gzip);
        const relleno = (512 - (size % 512)) % 512;
        if (relleno) await escribir(gzip, Buffer.alloc(relleno));
    }

    await escribir(gzip, Buffer.alloc(1024));
    await new Promise((resolve, reject) => {
        out.on('close', resolve);
        out.on('error', reject);
        gzip.end();
    });
}

// ---------------- AR ----------------
async function escribirAr(miembros, destino) {
    const out = fs.createWriteStream(destino);
    await escribir(out, Buffer.from('!<arch>\n', 'ascii'));
    for (const m of miembros) {
        const size = m.datos ? m.datos.length : fs.statSync(m.origen).size;
        const cabecera = Buffer.alloc(60, 0x20);
        cabecera.write(m.nombre.padEnd(16, ' ').slice(0, 16), 0, 16, 'ascii');
        cabecera.write(String(Math.floor(Date.now() / 1000)).padEnd(12, ' ').slice(0, 12), 16, 12, 'ascii');
        cabecera.write('0'.padEnd(6, ' ').slice(0, 6), 28, 6, 'ascii');
        cabecera.write('0'.padEnd(6, ' ').slice(0, 6), 34, 6, 'ascii');
        cabecera.write('100644'.padEnd(8, ' ').slice(0, 8), 40, 8, 'ascii');
        cabecera.write(String(size).padEnd(10, ' ').slice(0, 10), 48, 10, 'ascii');
        cabecera.write('`\n', 58, 2, 'ascii');
        await escribir(out, cabecera);
        if (m.datos) await escribir(out, m.datos);
        else await volcarFichero(m.origen, out);
        if (size % 2 === 1) await escribir(out, Buffer.from('\n', 'ascii'));
    }
    await new Promise((resolve, reject) => {
        out.on('close', resolve);
        out.on('error', reject);
        out.end();
    });
}

// ---------------- Verificación ----------------
function leerMiembrosAr(ruta) {
    const fd = fs.openSync(ruta, 'r');
    const cabecera = Buffer.alloc(8);
    fs.readSync(fd, cabecera, 0, 8, 0);
    if (cabecera.toString('ascii') !== '!<arch>\n') throw new Error('No es un archivo ar válido');
    let offset = 8;
    const total = fs.statSync(ruta).size;
    const miembros = [];
    while (offset + 60 <= total) {
        const h = Buffer.alloc(60);
        fs.readSync(fd, h, 0, 60, offset);
        if (h.toString('ascii', 58, 60) !== '`\n') break;
        const nombre = h.toString('ascii', 0, 16).trim();
        const size = parseInt(h.toString('ascii', 48, 58).trim(), 10);
        miembros.push({ nombre, size, offset: offset + 60 });
        offset += 60 + size + (size % 2);
    }
    fs.closeSync(fd);
    return miembros;
}

function verificarTarGz(ruta, esperados) {
    const datos = zlib.gunzipSync(fs.readFileSync(ruta));
    let p = 0;
    let ficheros = 0;
    let total = 0;
    const nombres = [];
    while (p + 512 <= datos.length) {
        const bloque = datos.subarray(p, p + 512);
        if (bloque.every((b) => b === 0)) break;
        const nombre = bloque.toString('utf8', 0, 100).replace(/\0.*$/, '');
        const prefijo = bloque.toString('utf8', 345, 500).replace(/\0.*$/, '');
        const completo = (prefijo ? prefijo + '/' : '') + nombre;
        const size = parseInt(bloque.toString('ascii', 124, 136).replace(/[^0-7]/g, '') || '0', 8) || 0;
        const tipo = bloque.toString('ascii', 156, 157);
        nombres.push(completo + (tipo === '5' ? '/' : ''));
        total += size;
        ficheros++;
        p += 512 + size + ((512 - (size % 512)) % 512);
    }
    const faltan = esperados.filter((e) => !nombres.includes(e));
    return { ficheros, total, nombres, faltan };
}

function verificarDeb(ruta) {
    const miembros = leerMiembrosAr(ruta);
    const control = miembros.find((m) => m.nombre === 'control.tar.gz');
    const datos = miembros.find((m) => m.nombre === 'data.tar.gz');
    const binario = miembros.find((m) => m.nombre === 'debian-binary');
    const out = { ruta, tamano: fs.statSync(ruta).size, miembros: miembros.map((m) => `${m.nombre} (${mb(m.size)})`) };

    if (!binario || !control || !datos) throw new Error('Faltan miembros obligatorios en el .deb');

    const fd = fs.openSync(ruta, 'r');
    const bufControl = Buffer.alloc(control.size);
    fs.readSync(fd, bufControl, 0, control.size, control.offset);
    const bufBin = Buffer.alloc(binario.size);
    fs.readSync(fd, bufBin, 0, binario.size, binario.offset);
    fs.closeSync(fd);

    out.debianBinary = bufBin.toString('utf8').trim();

    const tarControl = zlib.gunzipSync(bufControl);
    let p = 0;
    const controlFiles = [];
    while (p + 512 <= tarControl.length) {
        const bloque = tarControl.subarray(p, p + 512);
        if (bloque.every((b) => b === 0)) break;
        const nombre = bloque.toString('utf8', 0, 100).replace(/\0.*$/, '');
        const size = parseInt(bloque.toString('ascii', 124, 136).replace(/[^0-7]/g, '') || '0', 8) || 0;
        const contenido = tarControl.subarray(p + 512, p + 512 + size).toString('utf8');
        controlFiles.push({ nombre, contenido });
        p += 512 + size + ((512 - (size % 512)) % 512);
    }
    out.control = (controlFiles.find((f) => f.nombre.includes('control')) || {}).contenido || '(sin control)';

    // data.tar.gz: se lee entero (es el paquete completo) para comprobar rutas clave
    const bufDatos = Buffer.alloc(datos.size);
    const fd2 = fs.openSync(ruta, 'r');
    fs.readSync(fd2, bufDatos, 0, datos.size, datos.offset);
    fs.closeSync(fd2);
    const tempTar = path.join(BUILD, 'data.tmp.tar.gz');
    fs.writeFileSync(tempTar, bufDatos);
    const esperados = [
        './opt/pescaderia-rana-facturador/pescaderia-rana-facturador',
        './opt/pescaderia-rana-facturador/resources/app/index.html',
        './opt/pescaderia-rana-facturador/resources/app/package.json',
        './opt/pescaderia-rana-facturador/resources/app/main.js',
        './opt/pescaderia-rana-facturador/resources/app/preload.js',
        './opt/pescaderia-rana-facturador/resources/app/js/ocr.js',
        './opt/pescaderia-rana-facturador/resources/app/vendor/qrcode.min.js',
        './opt/pescaderia-rana-facturador/resources/app/vendor/tesseract/lang/spa.traineddata.gz',
        './usr/bin/pescaderia-rana-facturador',
        './usr/share/applications/pescaderia-rana-facturador.desktop',
        './usr/share/icons/hicolor/512x512/apps/pescaderia-rana-facturador.png',
    ];
    out.datos = verificarTarGz(tempTar, esperados);
    fs.rmSync(tempTar, { force: true });
    return out;
}

// ---------------- Construcción ----------------
async function construir() {
    fs.mkdirSync(CACHE, { recursive: true });
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const zipPath = path.join(CACHE, `electron-v${ELECTRON_VERSION}-linux-${ELECTRON_ARCH}.zip`);
    const zipUrl = `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-linux-${ELECTRON_ARCH}.zip`;

    if (!fs.existsSync(zipPath)) {
        log(`descargando Electron ${ELECTRON_VERSION} (linux-${ELECTRON_ARCH})…`);
        await descargar(zipUrl, zipPath);
    } else {
        log(`usando Electron en caché: ${path.basename(zipPath)} (${mb(fs.statSync(zipPath).size)})`);
    }

    if (!REUSAR || !fs.existsSync(path.join(ELECTRON_DIR, 'electron'))) {
        rmrf(ELECTRON_DIR);
        log('descomprimiendo Electron…');
        descomprimirZip(zipPath, ELECTRON_DIR);
    } else {
        log('reutilizando Electron ya descomprimido');
    }

    // 1) Árbol de empaquetado
    rmrf(STAGE);
    const optDir = path.join(STAGE, 'opt', 'pescaderia-rana-facturador');
    log('copiando Electron al paquete…');
    copiarArbol(ELECTRON_DIR, optDir, new Set());

    const binElectron = path.join(optDir, 'electron');
    const binFinal = path.join(optDir, 'pescaderia-rana-facturador');
    fs.renameSync(binElectron, binFinal);
    fs.chmodSync(binFinal, 0o755);
    recortarIdiomas(optDir);

    const appDir = path.join(optDir, 'resources', 'app');
    rmrf(path.join(optDir, 'resources', 'default_app.asar'));
    log('copiando la aplicación (index.html, js, vendor…)…');
    copiarArbol(ROOT, appDir, EXCLUIR);

    // El envoltorio de Electron no puede faltar: sin package.json y main.js la
    // app instalada no arrancaría (la carpeta escritorio/ queda excluida arriba).
    log('copiando el envoltorio de escritorio (main.js, preload.js, package.json)…');
    for (const fichero of ['main.js', 'preload.js', 'puente.js', 'package.json']) {
        fs.copyFileSync(path.join(__dirname, fichero), path.join(appDir, fichero));
    }

    // 2) Accesos, menú y icono
    const binLink = path.join(STAGE, 'usr', 'bin');
    fs.mkdirSync(binLink, { recursive: true });
    const lanzador = '#!/bin/sh\nexec /opt/pescaderia-rana-facturador/pescaderia-rana-facturador "$@"\n';
    fs.writeFileSync(path.join(binLink, 'pescaderia-rana-facturador'), lanzador, { mode: 0o755 });

    const appsDir = path.join(STAGE, 'usr', 'share', 'applications');
    fs.mkdirSync(appsDir, { recursive: true });
    const desktop = [
        '[Desktop Entry]',
        'Type=Application',
        'Version=1.0',
        'Name=Pescadería Rana Facturador',
        'Comment=Trazabilidad y facturación de Pescadería Rana (sin conexión)',
        'Exec=/opt/pescaderia-rana-facturador/pescaderia-rana-facturador %U',
        'Terminal=false',
        'Categories=Office;Finance;',
        'StartupWMClass=pescaderia-rana-facturador',
        'Icon=pescaderia-rana-facturador',
        'Keywords=factura;pescaderia;lote;trazabilidad;',
        '',
    ].join('\n');
    fs.writeFileSync(path.join(appsDir, 'pescaderia-rana-facturador.desktop'), desktop);

    const iconDir = path.join(STAGE, 'usr', 'share', 'icons', 'hicolor', '512x512', 'apps');
    fs.mkdirSync(iconDir, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'assets', 'icon-512.png'), path.join(iconDir, 'pescaderia-rana-facturador.png'));

    // 3) control.tar.gz
    let sumaKb = 0;
    const recorrer = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) recorrer(p);
            else sumaKb += Math.ceil(fs.statSync(p).size / 1024);
        }
    };
    recorrer(optDir);

    const control = [
        `Package: pescaderia-rana-facturador`,
        `Version: ${VERSION}`,
        'Section: utils',
        'Priority: optional',
        `Architecture: ${TARGET_ARCH}`,
        `Depends: ${DEPENDENCIAS.join(', ')}`,
        'Maintainer: Pescaderia Rana <soporte@pescaderia-rana-facturador.local>',
        `Installed-Size: ${sumaKb}`,
        'Description: Trazabilidad y facturacion de Pescaderia Rana, sin conexion',
        ' Facturador con formato oficial, escaneo de papeletas con OCR local y',
        ' agenda de clientes. Todo funciona sin conexion: los datos se guardan',
        ' en el propio equipo y hay copia de seguridad exportable.',
        '',
    ].join('\n');

    const controlTar = path.join(BUILD, 'control.tar.gz');
    log('empaquetando control.tar.gz…');
    await escribirTarGz([
        { ruta: 'control', datos: Buffer.from(control, 'utf8'), modo: 0o644 },
    ], controlTar);

    // 4) data.tar.gz
    log('empaquetando data.tar.gz (puede tardar un par de minutos)…');
    const entradas = [];
    const agregar = (dir, rel) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) {
                entradas.push({ ruta: r, tipo: '5', modo: 0o755 });
                agregar(p, r);
            } else {
                let modo = 0o644;
                if (SETUID.has(r)) modo = 0o4755;
                else if (EJECUTABLES.has(r)) modo = 0o755;
                else if (process.platform !== 'win32') {
                    const enDisco = fs.statSync(p).mode & 0o777;
                    if (enDisco) modo = enDisco;
                }
                entradas.push({ ruta: r, origen: p, modo });
            }
        }
    };
    agregar(STAGE, '');
    const dataTar = path.join(BUILD, 'data.tar.gz');
    await escribirTarGz(entradas, dataTar);

    // 5) .deb (ar)
    log('ensamblando el paquete .deb…');
    await escribirAr([
        { nombre: 'debian-binary', datos: Buffer.from('2.0\n', 'utf8') },
        { nombre: 'control.tar.gz', origen: controlTar },
        { nombre: 'data.tar.gz', origen: dataTar },
    ], DEB_PATH);

    log(`.deb creado: ${DEB_PATH} (${mb(fs.statSync(DEB_PATH).size)})`);
}

(async () => {
    try {
        if (SOLO_VERIFICAR) {
            if (!fs.existsSync(DEB_PATH)) throw new Error(`No existe ${DEB_PATH}`);
        } else {
            await construir();
        }
        const info = verificarDeb(DEB_PATH);
        console.log('\n──── Verificación del paquete ────');
        console.log('Archivo :', info.ruta, '(' + mb(info.tamano) + ')');
        console.log('Miembros:', info.miembros.join(', '));
        console.log('debian-binary:', info.debianBinary);
        console.log('\ncontrol:\n' + info.control.trim());
        console.log('\nContenido:', info.datos.ficheros, 'entradas ·', mb(info.datos.total), 'sin comprimir');
        console.log('Muestra  :', info.datos.nombres.slice(0, 5).join(', '));
        if (info.datos.faltan.length) {
            console.log('⚠️ FALTAN rutas esperadas:', info.datos.faltan.join(', '));
            process.exitCode = 1;
        } else {
            console.log('✅ Estructura correcta: todas las rutas clave presentes.');
        }
        console.log('\nInstalación en Linux:  sudo apt install ./' + DEB_NAME);
    } catch (err) {
        console.error('✗ Error:', err.message);
        process.exitCode = 1;
    }
})();
