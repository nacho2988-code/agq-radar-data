# agq-radar-data

Barrido diario automático del feed oficial de licitaciones (PLACSP) filtrado por el
perfil sectorial de AGQ Labs. Genera `data/licitaciones.json`, que la app
"Radar de Licitaciones AGQ" lee sola cada vez que la abres.

## Montaje (una sola vez)

1. **Crear el repositorio**: en GitHub, "New repository" → público → nómbralo como quieras
   (ej. `agq-radar-data`). Público es importante: así `raw.githubusercontent.com` sirve el
   JSON sin necesidad de token, y el navegador puede leerlo directamente. No hay datos
   sensibles aquí — solo licitaciones públicas filtradas; tus notas y favoritos de la app
   se quedan siempre en tu navegador (localStorage), nunca se suben a este repo.

2. **Subir estos 4 elementos** manteniendo la estructura de carpetas exacta:
   - `.github/workflows/daily-sweep.yml`
   - `scripts/fetch-and-filter.mjs`
   - `config/accreditations.json`
   - `data/licitaciones.json`

   Lo más fácil: arrastra la carpeta entera en la interfaz web de GitHub ("Add file" →
   "Upload files"), o si usas git: `git add . && git commit -m "init" && git push`.

3. **Dar permiso de escritura a las Actions** (paso que mucha gente se salta y por el que
   falla el primer commit): en el repo, ve a `Settings → Actions → General → Workflow
   permissions` y marca **"Read and write permissions"**. Guarda.

4. **Lanzarlo una vez a mano** para generar el primer snapshot: pestaña `Actions` →
   "Barrido diario de licitaciones AGQ" → `Run workflow`. Tarda menos de un minuto.
   Comprueba que `data/licitaciones.json` se ha actualizado con entradas.

5. **Conectar la app**: en "Radar de Licitaciones AGQ", pestaña *Importar datos* →
   sección de sincronización automática → escribe `tu-usuario/agq-radar-data` →
   *Guardar y sincronizar ahora*. A partir de aquí, cada vez que abras la app intentará
   traer el último snapshot sola.

## Después del montaje

- El workflow corre solo cada día a las 05:00 UTC (≈06:00–07:00 en España según el
  horario). Para cambiar la hora, edita el `cron` en `daily-sweep.yml`
  ([crontab.guru](https://crontab.guru) ayuda a construir la expresión).
- Por defecto sigue hasta 3 páginas del feed (≈1500 licitaciones de toda España)
  cada día. Si alguna vez ves que faltan licitaciones que sabes que están publicadas,
  sube `MAX_PAGES` en `scripts/fetch-and-filter.mjs`.
- Si en la app cambias las acreditaciones o palabras clave (pestaña *Acreditaciones AGQ*),
  eso solo afecta a cómo se clasifica lo que ya está descargado. Para que la Action
  también lo tenga en cuenta al decidir qué se descarga, usa el botón *"Copiar JSON para
  config/accreditations.json"* de esa misma pestaña y pega el resultado sustituyendo el
  fichero `config/accreditations.json` de este repo.
- Las entradas resueltas/cerradas hace más de 90 días se purgan solas del snapshot para
  que no crezca sin límite (ajustable con `STALE_DAYS` en el script).
