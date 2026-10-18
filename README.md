# uptime-monitor

Monitor de disponibilidad externo, en GitHub Actions (cada 10 min), con alertas a Telegram solo en
**cambios de estado** (caída tras 2 fallos seguidos, y recuperación).

Es público a propósito: en repos públicos los minutos de Actions no se facturan. **No contiene
secretos, IPs ni tokens**; solo URLs públicas. Las credenciales de Telegram van como secrets del repo.

## Qué vigila

| Objetivo | Chequeo |
| --- | --- |
| `https://smartrefresh.app/` | HTTP < 400 |
| `https://smartrefresh.app/api/health` | HTTP < 400 **y** cuerpo `"ok":true` — API de SmartRefresh (`sr_api`). La home es estática: sin esto, la API estuvo caída 5 días (2026-10-13→18) sin alerta |
| `https://vissed.com/` | HTTP < 400 |
| `https://falcontrend.com/` | HTTP < 400 |
| `https://vissed.com/privacy` | HTTP < 400 |
| `https://www.falcongrow.com/` | HTTP < 400 |
| `https://www.falcongrow.com/comprar/seguidores-instagram` | HTTP < 400 **y** el HTML contiene `AggregateOffer` (si no: "sin precio en el HTML") |
| `https://master.meclab.cl/healthz` | HTTP < 400 **y** cuerpo `ok` — API de VehiculosBD + base (VPS propio vbd-01; el sitio pide credenciales, este path no) |
| `https://master.meclab.cl/healthz/host` | HTTP < 400 **y** cuerpo `ok` — resultado de la vigilancia local de vbd-01 (disco, RAM, contenedores, backups) |

Los cuatro primeros comparten un mismo edge nginx; si caen todos a la vez, la alerta lo dice.

## Configuración

```sh
gh secret set TG_BOT_TOKEN -R sebavasdiaz/uptime-monitor   # pide el valor por stdin
gh secret set TG_CHAT_ID   -R sebavasdiaz/uptime-monitor
```

Sin esos secrets el chequeo corre igual y el log dice `Telegram NO configurado`.

## Operación

- Probar a mano: `gh workflow run uptime.yml -R sebavasdiaz/uptime-monitor`
- Local: `node scripts/uptime-check.mjs --no-notify` · tests: `node --test`
- Estado entre corridas: caché de Actions (`.uptime-state.json`).
- **Keepalive:** GitHub desactiva los cron de repos públicos tras 60 días sin actividad; el job
  `keepalive` hace un commit vacío el día 1 de cada mes.
- Pausar: `gh workflow disable uptime.yml -R sebavasdiaz/uptime-monitor`.
