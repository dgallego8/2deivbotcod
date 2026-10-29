# Subir tu bot a Railway

Esta carpeta contiene la versión para nube. El bot local sigue en `whatsapp-local`.
Incluye una copia de tu diccionario y la plantilla Solventa. No contiene la sesión de WhatsApp ni contraseñas.

## 1. Subir los archivos a GitHub

En https://github.com/new crea un repositorio llamado `mi-bot-whatsapp` y selecciona **Private**.
En el repositorio elige **uploading an existing file** o **Add file → Upload files**.
Arrastra el contenido de esta carpeta: `app.js`, `Dockerfile`, `railway.json`, `package.json`, `package-lock.json`, las carpetas `lib`, `public`, `assets`, `data` y los demás archivos de configuración. Pulsa **Commit changes**.
`Dockerfile` debe quedar en la raíz del repositorio. No subas el ZIP como un archivo: extrae su contenido primero.
Mantén el repositorio privado porque contiene tu diccionario.

## 2. Crear el servicio

En https://railway.com elige **New Project → Deploy from GitHub repo**, conecta GitHub y selecciona el repositorio privado.
Railway detectará el Dockerfile. El primer intento puede fallar hasta completar los siguientes ajustes.

## 3. Guardar la sesión y el diccionario

Añade un **Volume** al servicio y usa **Mount Path: `/data`**.
La sesión, el diccionario y la configuración se guardarán allí. No elimines ese volumen si quieres conservarlos.
Usa una sola instancia del servicio.

## 4. Proteger el panel

En el servicio, sección **Variables**, añade:

| Variable | Valor |
|---|---|
| `PANEL_USER` | Un usuario, por ejemplo `santi` |
| `PANEL_PASSWORD` | Una contraseña nueva de al menos 16 caracteres |

No pongas la contraseña en GitHub. Las demás rutas necesarias ya están definidas en el Dockerfile.
En **Settings → Networking → Generate Domain**, genera un dominio público. Si pregunta por el puerto, usa `8080`.
Railway proporciona `RAILWAY_PUBLIC_DOMAIN`; si el arranque dice que falta el dominio, añade `PUBLIC_URL` con la dirección completa `https://…up.railway.app`.
Aplica los cambios y vuelve a desplegar el servicio.

## 5. Vincular WhatsApp y probar

Primero pausa o apaga el bot local desde su panel para evitar que ambos respondan.
Abre el dominio de Railway. El navegador pedirá el usuario y la contraseña que configuraste.
Escanea el QR desde **WhatsApp personal → Dispositivos vinculados → Vincular dispositivo**.
Cuando diga **Conectado**, envía `150.000` desde Business `+573024849179` al personal `+573155901177`.
Debe responder con la plantilla y el QR correspondiente. Esta vinculación es nueva; no se copió la sesión de tu PC.
Si Railway limita memoria y Chromium no inicia, revisa los logs y el límite disponible de tu plan.

## Actualizar el diccionario

En el panel, **Actualizar diccionario → seleccionar payloads_generados.json → Subir JSON**.
Las consultas siguientes usarán ese archivo. Se conserva una copia `.bak` de la versión anterior en el volumen.
Editar el JSON del repositorio después del primer arranque no reemplaza el que ya está guardado en el volumen.
Los cambios de tu archivo de Windows no se sincronizan solos con Railway.
Para pausar el bot usa **Pausar respuestas**; para detener el alojamiento usa Railway.

## Plan gratis y comprobaciones

Railway ofrece una prueba de hasta $5/30 días y después $1 de crédito mensual en Free. El crédito no garantiza este bot funcionando todo el mes: mantiene Chromium abierto y su consumo depende del uso. Consulta https://docs.railway.com/pricing/free-trial.
Guía oficial de despliegue: https://docs.railway.com/quick-start. Los datos requieren volumen: https://docs.railway.com/services.
La versión conserva la corrección de envío de imágenes del bot local. Se comprobaron la protección del panel, la carga del JSON y la persistencia tras reinicio. La vinculación y el envío reales en Railway se comprueban después de desplegar.

Validación local: 52 pruebas correctas y comprobación HTTP del panel. No se pudo construir el contenedor aquí porque Docker Desktop no está iniciado; Railway realizará esa construcción al desplegar.
