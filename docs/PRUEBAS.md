# Evidencia de pruebas

Ejecutadas el 30 de octubre de 2026 en una copia aislada.

| Comprobación | Resultado |
|---|---|
| `npm run typecheck` | Correcta; incluye implementación, pruebas y configuración de Vitest |
| `npm run build` | Correcta; genera `dist/index.js`, `dist/models.js`, `dist/discovery.js` |
| `npm test -- --reporter=verbose` | **50/50 pruebas aprobadas**, 1 archivo, sin errores no controlados |
| `npm run test:native` | **15/15 escenarios aprobados**, CLI y SDK reales de `openclaw@2026.10.9` |
| `git diff --check` | Sin errores de espacios o parches |

Entorno: Node 24.22.2, npm 12.2.1, Vitest 3.2.7, OpenClaw 2026.10.9.
Las dependencias están fijadas en `package-lock.json`; la instalación se hizo
con scripts de dependencias desactivados. Los registros completos acompañan la
entrega (`evidencia/`). No hay claves reales en los fixtures ni en los registros.

## Qué se probó

Las 50 pruebas incluyen:

- Registro nativo, catálogo estático sin red, ids exactos y metadatos.
- Eliminación del filtro de nombres y rechazo de ids inválidos.
- Ruta `/v1/models`, URL con prefijo de proxy, rechazo de URL con credenciales.
- Uso de `discoveryApiKey` frente a un marcador `apiKey` del host.
- Sustitución completa del catálogo ante altas, bajas y lista vacía.
- Rotación y eliminación de claves, dos claves concurrentes en una URL,
  rotación durante la consulta y límite de reintentos.
- HTTP 401, 403, 429, 500, 503, desconexión, timeout, HTML, JSON roto y esquemas
  inválidos; recuperación posterior sin conservar filas antiguas.
- Paginación completa e incompleta, cancelación y rechazo de redirecciones.
- Rechazo de clave ausente/antigua/marcador, sin consulta anónima.
- Resolución dinámica con perfil bloqueado, revocación antes de inferencia,
  credenciales eliminadas y errores del resolvedor.
- Coexistencia con proveedor estático: no mutación de su configuración,
  sin importar su clave/modelos/cabeceras; URL heredada solamente.
- Rechazo de filas estáticas, cabeceras de credenciales y URL en conflicto en
  el nuevo proveedor; rechazo de una ruta de inferencia que cambió.

Las pruebas unitarias sustituyen únicamente el resolvedor del almacén de
credenciales para controlar las carreras. Las solicitudes HTTP usan el cliente
real protegido del SDK contra un servidor efímero en `127.0.0.1`.

Los **15 escenarios nativos** complementan esa sustitución:

1. Listado inicial de dos modelos mediante la CLI real.
2. Alta/baja: los dos anteriores se sustituyen por uno nuevo.
3. Revocación total: listado vacío.
4. HTTP 403: listado vacío.
5. HTTP 500: listado vacío, sin restaurar filas persistidas.
6. Cambio de clave: las solicitudes usan exclusivamente la nueva.
7. Eliminación de clave: no se envía ninguna solicitud anónima.
8. Proveedor estático `bifrost` sigue disponible y el archivo de configuración
   temporal se conserva idéntico.
9. Resolución de credenciales con el SDK real, sin mock.
10. Rotación de la variable de entorno en el mismo proceso.
11. Hook de autenticación previo a inferencia con la clave seleccionada.
12. Eliminación de credencial de entorno.
13. Lectura de un perfil guardado con una clave ficticia.
14. Actualización de ese perfil mediante la API real del SDK y nueva resolución.
15. Eliminación del perfil y rechazo del modelo previamente accesible.

Resultado final nativo: `status: PASS`, `scenarios: 15`, `httpRequests: 12`.
El programa verifica las cabeceras recibidas, los modelos listados y la
integridad de la configuración; no se limita a comprobar el código de salida.

## Incidencias encontradas durante la validación

- La primera ejecución de las pruebas originales no pudo abrir sockets locales
  en el entorno restringido (`listen EPERM`). No se contabilizó como un fallo
  funcional del plugin. Las pruebas finales se ejecutaron con acceso a sus
  servidores de prueba.
- Cargar directamente el directorio de desarrollo, que contiene al host dentro
  de `node_modules`, produjo un error de propiedad ambigua de un módulo público
  del plugin OpenAI incluido. Una copia de distribución sin dependencias de
  desarrollo pasó la prueba con los plugins incluidos del host habilitados.
  No se parcheó ni se deshabilitó OpenClaw para conseguir el resultado.
- Una comprobación inicial del resolvedor sin el manifiesto cargado no resolvía
  la variable de entorno del proveedor nuevo. La prueba final usa la misma
  configuración de carga del plugin que la CLI.
- El SDK emite un recibo de cierre de su base de datos después del resultado del
  programa. Se corrigió el lector de evidencia para distinguir ambos mensajes.

## Qué no demuestran estas pruebas

No se conectó al Bifrost del usuario, no se leyó su configuración o almacén de
credenciales y no se ejecutó ningún modelo real. No se probó la interfaz gráfica,
notificación inmediata de cambios, cancelación de inferencias en curso, un proxy
con doble autenticación ni otros SDK/versiones. El hook previo a inferencia sí
se probó; no se probó una generación completa pasando por un proveedor LLM.

La autorización definitiva sigue perteneciendo a Bifrost. Un servidor que ignore
la clave o no filtre su catálogo no permite inferir los permisos desde
`/v1/models`. La interfaz puede conservar referencias configuradas o un catálogo
hasta su siguiente refresco nativo. La documentación no promete refresco por
reloj ni que las filas estáticas del proveedor antiguo desaparezcan.
