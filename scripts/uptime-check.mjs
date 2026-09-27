#!/usr/bin/env node
/**
 * Chequeo de disponibilidad de los dominios del portafolio, con alerta a Telegram.
 *
 * POR QUÉ VIVE EN UN REPO PÚBLICO APARTE:
 * Vigila dominios de proyectos distintos (el edge compartido de smartrefresh.app / vissed.com /
 * falcontrend.com y, en otro VPS, falcongrow.com). Ponerlo en el repo de un producto haría que el
 * monitoreo de infra dependiera de ese producto. Y en un repo público los minutos de GitHub Actions
 * no se facturan: un cron cada 10 min en un repo privado consumía la cuota de toda la cuenta.
 * Origen: `scripts/uptime-check.mjs` del repo (privado) vissed, donde está documentada la infra.
 * El repo es PÚBLICO: aquí no va ningún secreto, IP ni token; solo URLs públicas.
 *
 * POR QUÉ CORRE FUERA DEL VPS:
 * El 2026-08-08 los tres dominios estuvieron ~45 horas caídos y nadie se enteró. Ya existía
 * monitoreo, pero corría EN EL VPS: un proceso que vive en la máquina caída no puede avisar que la
 * máquina está caída. Ese punto ciego es la causa de las 45 horas de silencio, así que este chequeo
 * se mira desde afuera (GitHub Actions).
 *
 * Sin dependencias: `fetch` y la API de Telegram por HTTPS. Nada que instalar, nada que mantener.
 *
 * Uso:
 *   node scripts/uptime-check.mjs                    # chequea (exit 1 si algo está caído)
 *   node scripts/uptime-check.mjs --state=s.json     # alerta solo en CAMBIOS de estado
 *   node scripts/uptime-check.mjs --no-notify        # sin Telegram
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

/**
 * Qué se vigila, y por qué importa cada uno (para quien lea la alerta de madrugada).
 *
 * - `edge: "compartido"` marca los dominios que pasan por el MISMO nginx de borde. Solo si caen
 *   TODOS esos se culpa al edge; falcongrow.com vive en otro VPS y no entra en esa cuenta.
 * - `mustContain`: además del status, el HTML debe contener esa cadena. Sirve para detectar una
 *   página que responde 200 pero ya no vende (sin precio en el HTML).
 */
export const TARGETS = [
  {
    name: "smartrefresh.app",
    url: "https://smartrefresh.app/",
    edge: "compartido",
    why: "Producto principal. Si está caído, hay usuarios afectados AHORA.",
  },
  {
    name: "vissed.com",
    url: "https://vissed.com/",
    edge: "compartido",
    why: "La Chrome Web Store verifica vissed.com: si no responde, no se puede publicar ni actualizar ninguna extensión.",
  },
  {
    name: "falcontrend.com",
    url: "https://falcontrend.com/",
    edge: "compartido",
    why: "Tercer dominio del edge compartido.",
  },
  {
    name: "vissed.com/privacy",
    url: "https://vissed.com/privacy",
    edge: "compartido",
    why: "La CWS exige que la política de privacidad sea accesible para aprobar un envío.",
  },
  {
    name: "falcongrow.com",
    url: "https://www.falcongrow.com/",
    why: "Tienda de FalconGrow (VPS propio, NO el edge compartido). Caída = no entran ventas.",
  },
  {
    name: "falcongrow.com/comprar",
    url: "https://www.falcongrow.com/comprar/seguidores-instagram",
    mustContain: "AggregateOffer",
    why: "Página de compra más vendida. Sin `AggregateOffer` en el HTML la página no muestra precio (y Google pierde el rich result).",
  },
];

export function isHealthy(result) {
  return (
    result.ok === true && result.status < 400 && result.contentMissing !== true
  );
}

/** Sondea una URL. Nunca lanza: un fallo de red ES el dato buscado, no una excepción. */
export async function probe(
  target,
  { timeoutMs = 15000, fetchImpl = fetch } = {},
) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(target.url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "uptime-monitor (github.com/sebavasdiaz)" },
    });
    const result = {
      name: target.name,
      url: target.url,
      ok: true,
      status: res.status,
      ms: Date.now() - startedAt,
    };
    // El cuerpo se lee dentro del mismo timeout (el AbortController también corta el streaming).
    if (target.mustContain && res.status < 400) {
      const body = await res.text();
      if (!body.includes(target.mustContain)) {
        result.contentMissing = true;
        result.error = `sin precio en el HTML (falta ${target.mustContain})`;
      }
    }
    return result;
  } catch (error) {
    return {
      name: target.name,
      url: target.url,
      ok: false,
      status: 0,
      ms: Date.now() - startedAt,
      // ECONNREFUSED vs timeout distingue "el proceso no está" de "la máquina no responde".
      // Lo primero fue el síntoma exacto del incidente del 2026-08-08.
      error: String(
        error?.cause?.code || error?.name || error?.message || "error",
      ).slice(0, 80),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeAll(targets = TARGETS, options = {}) {
  return Promise.all(targets.map((t) => probe(t, options)));
}

/**
 * Cuántos fallos SEGUIDOS hacen falta para avisar. Un chequeo aislado da falsos positivos: durante
 * las pruebas, dos de los cuatro objetivos dieron `UND_ERR_CONNECT_TIMEOUT` y a los segundos
 * respondían 200. Con umbral 1, ese parpadeo dispara una "CAÍDA" y un "RECUPERADO" diez minutos
 * después — el ruido que hace que la gente deje de mirar el canal. Con 2, una caída real se detecta
 * en ~20 min (dos ciclos) y un parpadeo no molesta a nadie.
 */
export const FAILURES_BEFORE_ALERT = 2;

/**
 * Decide qué notificar comparando con el estado anterior.
 *
 * El estado por objetivo es `{ fails, alerted }`:
 *  - `fails`   — fallos consecutivos, para el umbral de arriba.
 *  - `alerted` — si ya se avisó de ESTA caída. Sin esto, una caída de 45 h con chequeo cada 10 min
 *    manda 270 mensajes idénticos y el canal se silencia.
 *
 * Acepta también el formato viejo (`{ [name]: boolean }`) para no perder el estado al desplegar.
 */
export function diffState(results, previous = {}) {
  const downNow = [];
  const recovered = [];
  const stillDown = [];
  const state = {};

  for (const r of results) {
    const prevRaw = previous[r.name];
    const prev =
      typeof prevRaw === "boolean"
        ? { fails: prevRaw ? 0 : FAILURES_BEFORE_ALERT, alerted: !prevRaw }
        : { fails: prevRaw?.fails ?? 0, alerted: prevRaw?.alerted ?? false };

    if (isHealthy(r)) {
      if (prev.alerted) recovered.push(r.name);
      state[r.name] = { fails: 0, alerted: false };
      continue;
    }

    const fails = prev.fails + 1;
    if (fails >= FAILURES_BEFORE_ALERT && !prev.alerted) {
      downNow.push(r.name);
      state[r.name] = { fails, alerted: true };
    } else {
      if (prev.alerted) stillDown.push(r.name);
      state[r.name] = { fails, alerted: prev.alerted };
    }
  }

  return {
    downNow,
    recovered,
    stillDown,
    state,
    shouldNotify: downNow.length > 0 || recovered.length > 0,
  };
}

/** El estado a persistir sale del propio diff, que ya lleva la cuenta de fallos consecutivos. */
export function nextState(_results, diff) {
  return diff.state;
}

export function buildAlert(results, diff) {
  const lines = [];
  if (diff.downNow.length > 0)
    lines.push(`🔴 <b>CAÍDA</b> — ${diff.downNow.length} objetivo(s)`);
  else if (diff.recovered.length > 0)
    lines.push(`✅ <b>RECUPERADO</b> — ${diff.recovered.join(", ")}`);

  lines.push("");
  for (const r of results) {
    const icon = isHealthy(r) ? "✅" : "🔴";
    const detail = isHealthy(r)
      ? `${r.status} · ${r.ms}ms`
      : (r.error ?? `HTTP ${r.status}`);
    lines.push(`${icon} <code>${r.name}</code> — ${detail}`);
  }

  const broken = results.filter((r) => !isHealthy(r));
  if (broken.length > 0) {
    const why = TARGETS.filter((t) =>
      broken.some((b) => b.name === t.name),
    ).map((t) => t.why);
    lines.push("", "<b>Por qué importa</b>", ...why.map((w) => `• ${w}`));

    // Si fallan TODOS los del edge compartido, el problema es el edge y no un sitio suelto. Se dice
    // explícito para no perder tiempo mirando el proyecto equivocado — fue justo el error del
    // 2026-08-08. Solo cuentan los objetivos marcados `edge: "compartido"`: falcongrow.com vive en
    // otro VPS y que esté sano no descarta que el edge esté caído (ni al revés).
    const edgeNames = new Set(
      TARGETS.filter((t) => t.edge === "compartido").map((t) => t.name),
    );
    const edgeResults = results.filter((r) => edgeNames.has(r.name));
    if (edgeResults.length > 0 && edgeResults.every((r) => !isHealthy(r))) {
      lines.push(
        "",
        "⚠️ <b>Fallan TODOS los del edge compartido</b> → es el edge (<code>infra_proxy</code>), no un sitio suelto.",
        "Primero: <code>docker ps -a | grep infra_proxy</code> y <code>docker logs infra_proxy --tail 20</code>.",
        "Causa más frecuente: un upstream que no resuelve impide que nginx arranque.",
        "Runbook: repo vissed, <code>docs/vps-infra.md</code> § Incidentes 2026-08-08.",
      );
    }
  }
  return lines.join("\n");
}

/**
 * Los nombres de variable de Telegram están desparramados por el portafolio: conviven
 * `TELEGRAM_TOKEN`, `TG_BOT_TOKEN`, `TOKEN_TELEGRAM_BOT`, `TG_CHAT_ID`, `TELEGRAM_CHAT_ID`… Se
 * aceptan todos en vez de imponer uno, porque el costo de no reconocer el que ya existe es que las
 * alertas no salen — y que no salgan es indistinguible de que todo esté bien.
 */
const TOKEN_KEYS = [
  "TG_BOT_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_TOKEN",
  "TOKEN_TELEGRAM_BOT",
  "BOT_TOKEN",
  "TG_TOKEN",
];
const CHAT_KEYS = ["TG_CHAT_ID", "TELEGRAM_CHAT_ID", "CHAT_ID", "TG_CHAT"];

/**
 * Config de Telegram. Cuando falta algo NO se limita a decir "falta": informa qué variables con
 * pinta de Telegram SÍ están definidas (solo los NOMBRES, jamás los valores).
 *
 * El motivo: el token estaba puesto como `TOKEN_TELEGRAM_BOT`, que no era un alias reconocido, y el
 * script solo decía "sin TG_BOT_TOKEN/TG_CHAT_ID". Con esa pista uno busca un token que falta, no
 * un nombre que no calza. Un error de configuración silencioso es la misma familia que el incidente
 * que originó este monitor.
 */
export function telegramConfig(env = process.env) {
  const tokenKey = TOKEN_KEYS.find((k) => env[k]);
  const chatKey = CHAT_KEYS.find((k) => env[k]);
  const configured = Boolean(tokenKey && chatKey);

  let hint = "";
  if (!configured) {
    const parecidas = Object.keys(env).filter((k) =>
      /TELEGRAM|TG_|BOT|CHAT/i.test(k),
    );
    const falta = [!tokenKey && "token", !chatKey && "chat id"]
      .filter(Boolean)
      .join(" y ");
    hint = `falta ${falta}.`;
    if (parecidas.length > 0) {
      hint += ` Definidas: ${parecidas.join(", ")}. Reconocidas — token: ${TOKEN_KEYS.join("|")} · chat: ${CHAT_KEYS.join("|")}`;
    }
  }
  return {
    token: tokenKey && env[tokenKey],
    chatId: chatKey && env[chatKey],
    configured,
    hint,
  };
}

export async function sendTelegram(
  text,
  { env = process.env, fetchImpl = fetch } = {},
) {
  const { token, chatId, configured, hint } = telegramConfig(env);
  if (!configured) return { sent: false, reason: hint };
  const res = await fetchImpl(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    },
  );
  return { sent: res.ok, reason: res.ok ? "ok" : `HTTP ${res.status}` };
}

async function main() {
  const argv = process.argv.slice(2);
  const statePath =
    argv.find((a) => a.startsWith("--state="))?.split("=")[1] ?? null;
  const notify = !argv.includes("--no-notify");

  // `--prueba`: manda UN mensaje de prueba y termina, sin tocar el estado. Sirve para comprobar que
  // los secrets de Telegram del repo funcionan sin esperar a una caída real (el monitor solo avisa
  // en las transiciones). Se lanza a mano: `gh workflow run uptime.yml -f prueba=true`.
  if (argv.includes("--prueba")) {
    const out = await sendTelegram(
      "🧪 uptime-monitor: mensaje de prueba. Si lo lees, las alertas de caída llegarán a este chat.",
    );
    console.log(out.sent ? "📨 prueba enviada a Telegram" : `⚠️ prueba NO enviada: ${out.reason}`);
    process.exit(out.sent ? 0 : 1);
  }

  const previous =
    statePath && existsSync(statePath)
      ? JSON.parse(readFileSync(statePath, "utf8"))
      : {};
  const results = await probeAll();
  const diff = diffState(results, previous);

  for (const r of results) {
    console.log(
      `${isHealthy(r) ? "✅" : "🔴"} ${r.name.padEnd(24)} ${r.ok ? r.status : ""}${r.error ? ` ${r.error}` : ""}`,
    );
  }
  if (statePath)
    writeFileSync(statePath, JSON.stringify(nextState(results, diff), null, 2));

  // Estado de la config en CADA corrida, aunque no haya nada que avisar. Sin esto, un monitor mal
  // configurado se ve idéntico a uno que no tiene nada que reportar — y ese silencio ambiguo es
  // exactamente lo que produjo las 45 horas del incidente.
  if (notify) {
    const cfg = telegramConfig();
    console.log(
      cfg.configured
        ? "\nTelegram: configurado"
        : `\n⚠️ Telegram NO configurado — ${cfg.hint}`,
    );
  }

  if (notify && diff.shouldNotify) {
    const out = await sendTelegram(buildAlert(results, diff));
    console.log(
      out.sent
        ? "\n📨 alerta enviada a Telegram"
        : `\n⚠️ no se envió: ${out.reason}`,
    );
  } else if (diff.stillDown.length > 0) {
    console.log(
      `\nℹ️ sigue caído (ya se avisó): ${diff.stillDown.join(", ")} — no se repite`,
    );
  }

  process.exit(results.some((r) => !isHealthy(r)) ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("FALLO del chequeo:", error);
    process.exit(2);
  });
}
