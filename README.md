# Asistencia Serafo

Sistema web instalable para control de asistencia, evidencias fotográficas, GPS, actividades, horarios y cronogramas mensuales.

## Requisitos
- Windows 10/11
- Node.js 20 o superior
- PostgreSQL 14 o superior

## 1. Crear la base de datos
Abre pgAdmin o SQL Shell (psql) y ejecuta:

```sql
CREATE DATABASE asistencia_serafo;
```

## 2. Configurar el proyecto
1. Extrae el ZIP en `C:\AsistenciaSerafo`.
2. Abre una terminal en esa carpeta.
3. Copia `.env.example` y renómbralo a `.env`.
4. Edita `DATABASE_URL` con tu usuario y contraseña de PostgreSQL.
5. Cambia `JWT_SECRET`, `ADMIN_PASSWORD` y `HELPER_PASSWORD` por claves seguras.

Ejemplo:
`DATABASE_URL=postgresql://postgres:TuClavePostgres@localhost:5432/asistencia_serafo`

## 3. Instalar y ejecutar
```bash
npm install
npm start
```
Abre `http://localhost:4000`.

## Usuarios iniciales
Los usuarios se crean automáticamente al iniciar por primera vez, con los valores del archivo `.env`:
- Administrador: `ADMIN_USERNAME` / `ADMIN_PASSWORD`
- Ayudante: `HELPER_USERNAME` / `HELPER_PASSWORD`

Cambia las contraseñas antes de utilizarlo con información real.

## Funciones incluidas
- Inicio de sesión con roles administrador y ayudante.
- Registro de entrada con fotografía capturada desde la cámara y GPS.
- Registro de salida con actividades múltiples, reposición opcional y GPS.
- Historial mensual de asistencias.
- Publicación de horario en días 30 y 31; una vez publicado no se reemplaza desde la interfaz.
- Generación de cronograma PDF con calendario real lunes-domingo y actividades registradas.
- Panel para configurar coordenadas y radio del lugar de trabajo; cuando se configuran, el servidor rechaza registros fuera del radio.
- Auditoría de inicios de sesión, publicaciones y registros.

## Cámara y GPS
La cámara y la geolocalización requieren un contexto seguro: `localhost` funciona en la computadora local; para acceder desde otros dispositivos se debe publicar con HTTPS. No abras la app desde una IP HTTP esperando que cámara/GPS funcionen.

## Antes de producción
Esta es una primera versión funcional para pruebas. Antes de utilizarla como control laboral definitivo:
- Publica detrás de HTTPS.
- Configura copias de seguridad de PostgreSQL y de `uploads/`.
- Configura las coordenadas reales del lugar.
- Revisa la política de conservación y acceso a fotografías.
- Implementa recuperación de contraseña y gestión de usuarios desde el panel.
- Prueba el proceso de horario mensual con el calendario y la zona horaria local.

## Nota de funcionamiento
El cronograma se genera a partir de las actividades registradas en la asistencia de cada fecha. La plantilla de referencia tiene una cuadrícula mensual de lunes a domingo; el PDF generado sigue esa estructura. El logo oficial todavía debe incorporarse cuando se proporcione el archivo de imagen.
