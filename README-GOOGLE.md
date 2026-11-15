# Sincronización con Google (Firebase) — puesta en marcha

La app funciona **siempre** sin nube: los datos se guardan en este equipo.
Esto es opcional y sirve para tener las mismas facturas y clientes en el PC y en
el móvil, y para no perderlo todo si se rompe el ordenador.

Coste: **0 €** con el plan gratuito Spark de Firebase (1 GiB guardado, 50.000
lecturas y 20.000 escrituras al día). A una pescadería le sobra.

Lo que hace: se entra con la cuenta de Google y solo **esa** cuenta puede leer
o escribir en la base de datos. Sin sesión iniciada, la nube queda en pausa y se
sigue trabajando en local; al volver la conexión se pone al día sola.

---

## 1. Crear el proyecto

1. Entra en <https://console.firebase.google.com> con tu cuenta de Google.
2. **Crear proyecto** → nombre (por ejemplo `pescaderia-rana`) → desactiva Google
   Analytics (no hace falta) → Crear.

## 2. Activar el acceso con Google

1. Menú izquierdo: **Compilación → Authentication** → *Comenzar*.
2. Pestaña **Sign-in method** → **Google** → activar → elige tu correo de
   soporte → **Guardar**.

## 3. Autorizar el dominio

1. En **Authentication → Settings → Authorized domains** → **Add domain**.
2. Añade `pescaderia-rana.onrender.com` (el de la web).
   `localhost` ya viene autorizado para las pruebas en el PC.

Sin este paso, al pulsar «Entrar con Google» sale el error
`auth/unauthorized-domain`.

## 4. Crear la base de datos

1. **Compilación → Firestore Database** → *Crear base de datos*.
2. Modo **producción**, ubicación `europe-west1` (o la más cercana).
3. Las reglas se pegan en el paso 7.

## 5. Copiar la configuración a la app

1. Rueda dentada (⚙) → **Configuración del proyecto → Tus apps**.
2. Icono **Web `</>`** → ponle nombre → *Registrar app*.
3. Copia el objeto `firebaseConfig` que aparece (`{ apiKey: "...", ... }`).
4. En la app: **Configuración → Sincronización en la Nube (Firebase + Google)**
   → pega el objeto en la caja → **Guardar configuración**.

## 6. Entrar con Google

1. Pulsa **Entrar con Google** y elige tu cuenta.
2. Debajo aparece tu correo y una línea con el **UID**: cópialo, hace falta en
   el paso siguiente.

## 7. Cerrar la base a tu cuenta

En **Firestore Database → Reglas**, pega esto cambiando `TU_UID` por el que
mostró la app, y pulsa *Publicar*:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    match /clients/{documento} {
      allow read, write: if request.auth != null && request.auth.uid == 'TU_UID';
    }

    match /invoices/{documento} {
      allow read, write: if request.auth != null && request.auth.uid == 'TU_UID';
    }
  }
}
```

Con esto, aunque alguien consiguiera la `firebaseConfig`, no puede leer ni
tocar nada: solo tu cuenta, desde la app.

---

## Cómo se comporta en el día a día

- **Un solo PC:** funciona igual que antes, sin nube. Si conectas Google, además
  se guarda una copia en la nube.
- **Dos equipos:** cambias algo en uno y aparece en el otro en segundos. Si los
  dos cambian lo mismo a la vez, gana el cambio más reciente (`updatedAt`).
- **Sin internet:** se sigue facturando en local; la subida queda en cola y se
  envía al volver la red.
- **Salir de Google** (botón *Salir de Google*) pausa la nube pero no borra nada.
- **Desconectar Nube** borra la configuración de este equipo; los datos de la
  nube y los locales se quedan como están.

## Problemas típicos

| Mensaje | Qué hacer |
| --- | --- |
| `auth/unauthorized-domain` | Añadir el dominio en Authentication → Settings (paso 3). |
| `auth/operation-not-allowed` | Falta activar el proveedor Google (paso 2). |
| Ventana de Google bloqueada | Permitir ventanas emergentes para el sitio. |
| `Error de sincronización` en la barra | Revisar las reglas del paso 7 y que el UID sea el tuyo. |
| Nube en pausa | Pulsar «Entrar con Google»: la sesión caduca al limpiar el navegador. |

## Cuota

- 50.000 lecturas y 20.000 escrituras al día. La primera subida de un equipo
  manda todo; a partir de ahí solo se envían los cambios.
- No se activa facturación: si algún día se superara la cuota, Firebase deja de
  sincronizar y la app sigue funcionando en local.
