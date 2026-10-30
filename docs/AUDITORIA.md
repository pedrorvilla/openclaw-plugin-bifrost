# Auditoría de las afirmaciones previas

Fecha: 30 de octubre de 2026. Repositorio base:
[mberatsanli/openclaw-plugin-bifrost, e81706e](https://github.com/mberatsanli/openclaw-plugin-bifrost/tree/e81706eed78bb0c06073656d38b4d6f9fe723b03).
La revisión precedió a los cambios. La conversación anterior se leyó como
antecedente, no como prueba. No se consultó la instalación ni las claves reales.

| Afirmación anterior | Resultado de la auditoría |
|---|---|
| Hay descubrimiento nativo de `/v1/models` | Confirmada: `catalog.run` usa `buildOpenAICompatibleLiveModelProviderConfig`, y existen `resolveDynamicModel` / `prepareDynamicModel`. |
| La caché dura 60 segundos | Parcial: ese TTL se pasa al SDK; la segunda caché `discoveredModels` del plugin no tiene caducidad. El hook síncrono puede seguir entregando sus filas indefinidamente. |
| El catálogo vacío conserva modelos antiguos | Confirmada: `rememberDiscoveredModels` abandona la función cuando `models.length === 0`. |
| Se reutilizan credenciales antiguas | Confirmada: `discoveryApiKeys` guarda `auth.apiKey` por URL y solo actualiza cuando es truthy. No borra claves retiradas y no distingue perfiles/agentes. Además, el catálogo puede usar `discoveryApiKey`, pero el hook posterior guarda/reutiliza `apiKey`, que puede ser un marcador. |
| Los hooks refrescan cada turno | No se puede afirmar: el hook de preparación retorna inmediatamente un modelo de la caché propia, sin comprobar TTL ni permisos; el host puede resolver antes una fila explícita. |
| El proveedor manual puede interferir | Confirmada en el host: se registraba el mismo id `bifrost`; `mergeProviderModels` conserva filas explícitas incluso si no aparecen en descubrimiento. |
| El plugin ignora la URL manual | Falsa como afirmación absoluta: el código original la lee como alternativa a la URL del plugin. |
| Muestra todos los modelos autorizados | Falsa: `NON_TEXT_MODEL_ID_PATTERN` elimina ids por patrones del nombre. No se verificó que el servidor real devuelva 450 modelos. |
| Bearer siempre sirve para cualquier Virtual Key | Requiere matiz: la documentación de Maxim indica que las claves antiguas sin `sk-bf-` requieren `x-bf-vk`. Esta versión exige claves modernas y falla si falta una. |
| Compatibilidad con OpenClaw 2026.10.9 | Las declaraciones antiguas no bastaban. Esta entrega fija esa dependencia y prueba el SDK y la CLI reales. No se extrapola a otras versiones. |

Fuentes verificadas:

- [index.ts original](https://github.com/mberatsanli/openclaw-plugin-bifrost/blob/e81706eed78bb0c06073656d38b4d6f9fe723b03/src/index.ts).
- [models.ts original](https://github.com/mberatsanli/openclaw-plugin-bifrost/blob/e81706eed78bb0c06073656d38b4d6f9fe723b03/src/models.ts).
- [Fusión de proveedores de OpenClaw](https://github.com/openclaw/openclaw/blob/8b18b5578f66eab1501cba4cef2310d88bfb9a41/src/agents/models-config.merge.ts): conserva modelos explícitos y añade los implícitos.
- [Contratos de runtime](https://github.com/openclaw/openclaw/blob/8b18b5578f66eab1501cba4cef2310d88bfb9a41/src/plugins/provider-runtime.types.ts): los hooks de modelos no reciben una clave; `prepareRuntimeAuth` recibe la credencial seleccionada para inferencia.
- [Orden de resolución del host](https://github.com/openclaw/openclaw/blob/8b18b5578f66eab1501cba4cef2310d88bfb9a41/src/agents/embedded-agent-runner/model.ts).
- [Virtual Keys de Maxim Bifrost](https://github.com/maximhq/bifrost/blob/dev/docs/features/governance/virtual-keys.mdx): formas de autenticación y alcance del listado. Esta documentación es mutable; no demuestra el comportamiento de la instalación del usuario.

El tag OpenClaw `v2026.10.9` apunta al commit
`8b18b5578f66eab1501cba4cef2310d88bfb9a41`, consistente con el identificador corto
mostrado en la conversación. Se descargó `openclaw@2026.10.9` para las pruebas;
el archivo de dependencias fija su integridad. No se invocó el ejecutable
OpenClaw instalado por el usuario.

## Decisiones de implementación

1. Catálogo sin caché del plugin: cada resultado es una fotografía completa de
   la consulta actual, incluidos los conjuntos vacíos. Se elimina también el
   mapa de claves por URL.
2. El SDK resuelve credenciales vigentes; se respeta `discoveryApiKey` y se
   rechazan respuestas de consultas cuyo contexto cambió durante la espera.
3. La preparación previa a la inferencia verifica el modelo con la clave real
   elegida por el host, para no confiar en filas antiguas del registro.
4. Proveedor `bifrost-live` separado. No se intenta borrar filas del usuario
   dentro de una fusión que las conserva deliberadamente.
5. Se elimina el filtro por nombre; se mantienen comprobaciones de ids, orden,
   deduplicación y proyección de metadatos.
6. Sin respuesta anónima alternativa, redirecciones ni recuperación silenciosa
   de resultados anteriores ante fallos.

No se creó un fork remoto ni se publicó un PR: el trabajo está en una rama de
una copia local aislada. Se entregan fuente, parche y paquete compilado.
