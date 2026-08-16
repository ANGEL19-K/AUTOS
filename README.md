# FleetGuard

Versión corporativa del sistema de gestión vehicular.

## Estado actual

- Inicio de sesión conectado con Supabase Auth.
- Lectura del perfil y rol desde `user_profiles`.
- Interfaz corporativa sin emojis.
- Buscador global para unidades, conductores, asignaciones, documentos, incidentes y mantenimientos.
- Buscadores independientes por módulo.
- Panel funcional de alertas.
- Fichas de detalle para los registros.
- Botones de navegación, apertura, cierre, exportación y eliminación funcionales.
- Datos operativos conectados a PostgreSQL/Supabase; `localStorage` queda solo como respaldo de migración/caché.

## Ejecutar

Abre la carpeta en Visual Studio Code y ejecuta `index.html` con Live Server.

## Configuración

`supabase-config.js` contiene únicamente la Project URL y la Publishable Key. No agregues `service_role`, Secret Key ni la contraseña de PostgreSQL.

## Arquitectura actual

Supabase es la fuente principal de datos y autenticación. Los archivos operativos se guardan en Supabase Storage. Cloudflare R2 puede incorporarse posteriormente si se decide mover archivos pesados.


## Ajustes v3
- Datos iniciales vacíos (sin bloque demoData).
- Iconos gráficos listos para usar desde assets/icons/.
- Se eliminó el bloque visual derecho del hero del panel principal.
- Se mejoró la visibilidad de iconos sobre fondos azules.
- Buscador superior usa buscar.png si el archivo existe.


## Ajustes v4
- Hero principal sin fondo azul.
- Iconografía aumentada para mejor visibilidad.
- Icono del buscador reducido.


## Ajustes v5
- Se eliminó por completo el bloque grande superior del panel principal.
- El dashboard ahora inicia directamente desde las tarjetas de resumen.
- Se corrigió la distorsión de iconos/imágenes usando `object-fit: contain` y tamaños máximos.


## Ajustes v6
- Las cuatro tarjetas principales vuelven a usar UN, AS, MA y AL.
- Se retiró la imagen de alerta del botón superior para evitar deformaciones.


## Ajuste v7
- Se conserva `alerta.png` en el botón superior.
- El icono queda contenido en 15 × 15 px dentro de un marco de 24 × 24 px.
- Si falta la imagen, se muestra `AL` como respaldo.


## Ajustes v8
- Se eliminó el panel azul izquierdo del login.
- La vista de acceso quedó solo con formulario de usuario y contraseña.
- La marca FleetGuard se mantiene arriba del formulario.


## Mejoras v9
- Conductores editables sin alterar los datos históricos ya copiados en las asignaciones.
- Incidentes identifican y guardan el conductor responsable según la fecha del incidente.
- Gastos mensuales calculados con costos de mantenimiento registrados y alquiler mensual configurado en unidades alquiladas.


## V10 - Chequeo pre-uso vehicular

Se agregó el módulo **Chequeo pre-uso** para registrar la inspección antes de sacar una unidad. Incluye placa/unidad, conductor de la asignación vigente, fecha y hora automáticas, odómetro, foto panorámica obligatoria, checklist visual, observaciones y resultado automático (Conforme / Con observaciones).

Nota histórica de V10: en esa versión los chequeos todavía eran locales. Desde V11 los chequeos se guardan en Supabase y desde V14 los módulos operativos también.

Si deseas un icono propio en el menú, agrega `assets/icons/chequeo.png`. Si no existe, FleetGuard mostrará el código `CK`.

## FleetGuard V11 - Chequeo pre-uso separado

Esta versión incorpora una página independiente para el personal:

- `chequeo.html`: formulario que puede abrirse desde un celular o PC sin entrar al panel administrativo.
- `index.html` → **Chequeo pre-uso**: historial administrativo de los registros recibidos.
- `07_preuse_checks.sql`: crea la tabla, funciones RPC, políticas RLS y el bucket privado `preuse-evidence`.

### Activación

1. Ejecuta `07_preuse_checks.sql` en **Supabase → SQL Editor**.
2. Sube `index.html`, `app.js`, `styles.css`, `chequeo.html`, `chequeo.js`, `chequeo.css` y `supabase-config.js` al mismo sitio de Render/GitHub.
3. La página para el personal quedará disponible en `/chequeo.html`.

Los registros enviados por el personal se almacenan en Supabase y el administrador puede revisarlos y editarlos desde FleetGuard.

## FleetGuard V12 - Evidencias por no conformidad

Cada punto marcado como **No conforme** solicita una descripción y una fotografía de evidencia obligatorias. La foto panorámica general continúa siendo independiente y obligatoria.

## FleetGuard V13 - Identificación solo por DNI

La página `chequeo.html` ahora solicita únicamente el DNI del trabajador. Al pulsar **Validar mi asignación**, FleetGuard consulta la asignación activa en Supabase y obtiene automáticamente el nombre del conductor, la placa, la unidad, el team y la zonal.

Si existe más de una unidad activa para el mismo DNI, se muestra un selector limitado a esas unidades. Si no existe una asignación activa, el formulario no permite registrar el chequeo.

Para actualizar una instalación V11/V12 ya existente, ejecuta `08_preuse_dni_lookup.sql` en **Supabase → SQL Editor** antes de publicar `chequeo.html` y `chequeo.js`.

## FleetGuard V14 - Operación completa en Supabase

Desde V14, Supabase es la fuente principal de los módulos operativos del dashboard:

- Unidades (`vehicles`)
- Conductores (`drivers`)
- Asignaciones (`vehicle_assignments`)
- Documentos (`vehicle_documents`)
- Incidentes (`incidents`)
- Mantenimientos (`maintenance_records`)
- Devoluciones (`vehicle_returns`)
- Gastos (`expenses`, lectura para cálculos/reportes)
- Evidencias (`attachments` + Supabase Storage)
- Chequeo pre-uso (`preuse_checks`)

Los archivos nuevos dejan de depender de IndexedDB: documentos, evidencias de incidentes, comprobantes de mantenimiento y fotos de devolución se suben a los buckets privados de Supabase Storage y se visualizan mediante URLs temporales firmadas.

### Migración de los registros anteriores

Al iniciar V14 por primera vez como administrador, FleetGuard detecta los datos que las versiones anteriores guardaban en `fleetguard-data-v3` y realiza una migración única a Supabase. La copia local anterior no se borra; queda como respaldo. Después de la migración, los módulos leen de Supabase.

### Activación de V14

1. Asegúrate de haber ejecutado previamente los scripts `01` a `08` usados durante la configuración de FleetGuard.
2. Ejecuta `09_fleetguard_cloud_v14.sql` en **Supabase → SQL Editor**.
3. Publica los archivos de V14 en GitHub/Render.
4. Inicia sesión una vez desde el navegador donde estaban tus registros locales para que se ejecute la migración automática.
5. Comprueba en **Supabase → Table Editor** que aparecen la unidad, conductor y asignación.
6. Después prueba `/chequeo.html`: con solo el DNI debe recuperar automáticamente la unidad asignada.

`09_fleetguard_cloud_v14.sql` también corrige la búsqueda del chequeo para que una fecha **estimada** de devolución ya vencida no invalide una asignación que continúa con estado `Activa` o `Pendiente de devolución`.
