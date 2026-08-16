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
- Datos operativos temporales almacenados en `localStorage`.

## Ejecutar

Abre la carpeta en Visual Studio Code y ejecuta `index.html` con Live Server.

## Configuración

`supabase-config.js` contiene únicamente la Project URL y la Publishable Key. No agregues `service_role`, Secret Key ni la contraseña de PostgreSQL.

## Próxima etapa

Reemplazar gradualmente `localStorage` por las tablas reales de Supabase, comenzando por `vehicles`.


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

Los registros operativos y sus fotos continúan guardándose localmente en el navegador (localStorage + IndexedDB) mientras se completa la conexión de los módulos con Supabase.

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
