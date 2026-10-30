# Instalación y verificación

Esta versión está preparada para revisión; **no se instaló en tu OpenClaw**.
Las pruebas se hicieron con OpenClaw 2026.10.9 descargado en una copia aislada,
Node 24.22.2, un servidor HTTP ficticio y claves de prueba.

## Decisión de coexistencia

El plugin conserva el identificador `bifrost`, pero publica el proveedor
**`bifrost-live`**. Tus entradas `models.providers.bifrost`, credenciales, cabeceras,
modelo predeterminado y referencias `bifrost/...` se conservan. El catálogo nuevo
usa referencias `bifrost-live/<id devuelto por Bifrost>`.

Esta separación es necesaria: OpenClaw combina los modelos explícitos y los
descubiertos, y un plugin no puede borrar las filas explícitas devolviendo una
lista vacía. El proveedor antiguo puede seguir mostrando modelos estáticos;
el catálogo vivo debe consultarse filtrando `bifrost-live`.

No añadas modelos individuales a `models.providers.bifrost-live.models`.
Se puede omitir por completo ese proveedor de la configuración. Si existe,
`models` debe estar vacío; no admite sobrescrituras de cabeceras de credenciales.

## Instalación posterior, decidida por el usuario

1. Conserva un respaldo mediante tu procedimiento habitual de OpenClaw. Comprueba
   que el plugin id `bifrost` no tenga dos propietarios instalados. Si ya instalaste
   el plugin comunitario original, esta versión lo sustituye; no es un segundo
   plugin para cargar simultáneamente. No sustituyas un plugin de otro origen sin
   comprobar primero su identidad.
2. Usa el `.tgz` entregado, que incluye los archivos compilados. No enlaces la
   carpeta de desarrollo que contiene `node_modules/openclaw`.
3. Ejecuta, sustituyendo las rutas y la URL de ejemplo:

```sh
openclaw plugins install /ruta/absoluta/openclaw-plugin-bifrost-0.2.0.tgz --accept-capabilities
openclaw config set plugins.entries.bifrost.config.baseUrl https://tu-bifrost.example/v1
openclaw models auth paste-api-key --provider bifrost-live
openclaw gateway restart
```

Introduce la Virtual Key vigente `sk-bf-...` en el diálogo interactivo. También
puedes proporcionar `BIFROST_API_KEY` al proceso de OpenClaw mediante tu gestor
habitual de secretos. No se copian automáticamente perfiles guardados bajo
`bifrost`, ni se mezclan credenciales de dos proveedores. La variable de entorno,
si está presente, sigue la precedencia que aplique OpenClaw.

Si omites la URL del plugin, se toma primero la URL del proveedor `bifrost-live`,
luego la de `bifrost`, y finalmente `http://localhost:8080/v1`. La nueva conexión
normaliza `/openai` y `/openai/v1` a `/v1`, conservando prefijos de proxy. Las URL
del plugin y del proveedor vivo deben coincidir; se rechazan URL con credenciales,
consulta o fragmento. El proveedor antiguo no se reescribe.

## Comprobación funcional

```sh
openclaw plugins list
openclaw models list --all --provider bifrost-live --refresh --json
openclaw models list --all --provider bifrost --json
```

El primer listado debe mostrar los modelos devueltos por `/v1/models` para la
clave nueva. El segundo conserva la conexión antigua. `--all` importa: sin él,
OpenClaw lista por defecto los modelos configurados. `models refresh` refresca
metadatos alojados; para este inventario usa `models list --refresh`.

Con una Virtual Key de prueba y un Bifrost de prueba:

| Cambio | Resultado esperado tras `models list --all --provider bifrost-live --refresh --json` |
|---|---|
| Autorizar un modelo nuevo | Aparece con su id exacto, sin editar listas de modelos |
| Revocar un modelo | Desaparece del catálogo vivo |
| Revocar todos los modelos | `models` vacío, sin recuperar filas anteriores |
| Invalidar la clave: 401/403 | Catálogo vacío y resultado `auth-rejected` |
| Error 500, desconexión o respuesta inválida | Catálogo vacío y resultado `unavailable` |
| Cambiar la clave | Solo aparece el catálogo de la clave nueva |
| Eliminar la credencial | No se consulta anónimamente ni se reutiliza la clave anterior |

Después, reabre el selector de modelos. Las políticas adicionales de OpenClaw
pueden limitar la selección: revisa `agents.defaults.models`, las políticas del
agente, `models.mode` y el estado del plugin. Esta versión no las amplía ni cambia
tu modelo predeterminado. Puedes elegir un modelo de chat del catálogo vivo y
hacer una petición breve desde OpenClaw; esa prueba real **no se realizó aquí**.

Los cambios en variables de entorno requieren que el proceso de gateway reciba
el nuevo entorno, normalmente reiniciándolo. Los cambios de perfiles se resuelven
mediante el SDK, y los de SecretRef dependen de la recarga de secretos de OpenClaw.

## Volver atrás

Deshabilita o retira este plugin mediante la gestión normal de plugins de
OpenClaw y reinicia el gateway. Si cambiaste el modelo predeterminado durante tus
pruebas, restaura tu referencia `bifrost/...` anterior. La configuración estática
original no fue modificada por el plugin. Los perfiles de `bifrost-live` se
administran separadamente; esta entrega no borra ningún perfil real.

## Límites que debes conocer

El refresco ocurre al invocar los hooks nativos, no mediante notificaciones
instantáneas a una pantalla ya abierta. No hay sondeo periódico ni sincronizador
que edite configuración. Los registros predeterminados o explícitos de OpenClaw
pueden persistir como configuración; no equivalen a autorización vigente.

Se exige una Virtual Key moderna `sk-bf-`. No se admiten claves antiguas que
necesiten `x-bf-vk`, doble autenticación administrativa, redirecciones ni modo
anónimo. El servidor debe filtrar `/v1/models` por clave y aplicar los permisos a
la inferencia. No se interrumpen peticiones ya iniciadas.

Todos los ids válidos se exponen, incluidos embeddings/audio/imagen; la ejecución
del plugin sigue usando chat completions. No se ha añadido soporte para sus
otras APIs, ni se han validado capacidades multimodales. Un modelo listado no
es una promesa de compatibilidad de ejecución.
