// Sin dependencias: `node --test` (runner nativo). `expect` es un shim mínimo sobre node:assert
// con la misma forma que vitest, para que los tests sigan siendo los del repo vissed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TARGETS,
  isHealthy,
  probe,
  probeAll,
  diffState,
  nextState,
  buildAlert,
  telegramConfig,
} from "./uptime-check.mjs";

const expect = (actual, msg) => ({
  toBe: (v) => assert.equal(actual, v, msg),
  toEqual: (v) => assert.deepEqual(actual, v, msg),
  toMatch: (re) => assert.match(actual, re, msg),
  toBeTruthy: () => assert.ok(actual, msg),
  toContain: (v) => assert.ok(actual.includes(v), msg),
  not: { toMatch: (re) => assert.doesNotMatch(actual, re, msg) },
});

// Helpers finos sobre expect, para que los tests se lean igual que en el resto del repo.
const expect_eq = (a, b) => expect(a).toBe(b);
const expect_deep = (a, b) => expect(a).toEqual(b);
const expect_match = (s, re) => expect(s).toMatch(re);
const expect_nomatch = (s, re) => expect(s).not.toMatch(re);
const expect_ok = (v, msg) => expect(v, msg).toBeTruthy();

const ok = (name) => ({
  name,
  url: `https://${name}/`,
  ok: true,
  status: 200,
  ms: 12,
});
const down = (name, error = "ECONNREFUSED") => ({
  name,
  url: `https://${name}/`,
  ok: false,
  status: 0,
  ms: 1,
  error,
});

test("isHealthy: 200 sano, 500 y error de red no", () => {
  expect_eq(isHealthy(ok("a")), true);
  expect_eq(isHealthy({ ok: true, status: 301 }), true);
  expect_eq(isHealthy({ ok: true, status: 500 }), false);
  expect_eq(isHealthy({ ok: true, status: 404 }), false);
  expect_eq(isHealthy(down("a")), false);
});

test("probe: un fallo de red devuelve un resultado, NO lanza", async () => {
  const fetchImpl = async () => {
    const e = new Error("connect ECONNREFUSED");
    e.cause = { code: "ECONNREFUSED" };
    throw e;
  };
  const r = await probe({ name: "x", url: "https://x/" }, { fetchImpl });
  expect_eq(r.ok, false);
  expect_eq(r.error, "ECONNREFUSED");
});

test("probe: registra el status y el tiempo cuando responde", async () => {
  const r = await probe(
    { name: "x", url: "https://x/" },
    { fetchImpl: async () => ({ status: 200 }) },
  );
  expect_eq(r.ok, true);
  expect_eq(r.status, 200);
  expect_ok(typeof r.ms === "number");
});

test("probe: un timeout no cuelga el chequeo", async () => {
  const fetchImpl = (_url, { signal }) =>
    new Promise((_res, rej) => {
      signal.addEventListener("abort", () =>
        rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
      );
    });
  const r = await probe(
    { name: "x", url: "https://x/" },
    { fetchImpl, timeoutMs: 30 },
  );
  expect_eq(r.ok, false);
  expect_eq(r.error, "AbortError");
});

test("probeAll: un objetivo caído no impide medir los demás", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("malo")) throw new Error("boom");
    return { status: 200 };
  };
  const results = await probeAll(
    [
      { name: "bueno", url: "https://bueno/" },
      { name: "malo", url: "https://malo/" },
    ],
    { fetchImpl },
  );
  expect_eq(results.length, 2);
  expect_eq(isHealthy(results[0]), true);
  expect_eq(isHealthy(results[1]), false);
});

test("diffState: UN fallo aislado NO alerta (anti-flapping)", () => {
  // Observado de verdad: dos objetivos dieron UND_ERR_CONNECT_TIMEOUT y a los segundos
  // respondían 200. Con umbral 1 eso dispara una CAÍDA y un RECUPERADO sin que pase nada.
  const d = diffState([down("a")], {});
  expect_deep(d.downNow, []);
  expect_eq(d.shouldNotify, false);
  expect_eq(d.state.a.fails, 1);
});

test("diffState: DOS fallos seguidos sí alertan", () => {
  const d = diffState([down("a")], { a: { fails: 1, alerted: false } });
  expect_deep(d.downNow, ["a"]);
  expect_eq(d.shouldNotify, true);
  expect_eq(d.state.a.alerted, true);
});

test("diffState: un objetivo sano resetea la cuenta de fallos", () => {
  const d = diffState([ok("a")], { a: { fails: 1, alerted: false } });
  expect_eq(d.state.a.fails, 0);
  expect_eq(d.shouldNotify, false);
});

test("diffState: ANTISPAM — seguir caído NO vuelve a avisar", () => {
  const d = diffState([down("a")], { a: { fails: 5, alerted: true } });
  expect_deep(d.stillDown, ["a"]);
  expect_deep(d.downNow, []);
  expect_eq(d.shouldNotify, false);
});

test("diffState: la recuperación se avisa solo si se había avisado la caída", () => {
  expect_deep(
    diffState([ok("a")], { a: { fails: 3, alerted: true } }).recovered,
    ["a"],
  );
  // Si el parpadeo nunca llegó a alertar, la vuelta a la normalidad no genera ruido.
  expect_eq(
    diffState([ok("a")], { a: { fails: 1, alerted: false } }).shouldNotify,
    false,
  );
});

test("diffState: todo sano y sin cambios no notifica nada", () => {
  expect_eq(diffState([ok("a"), ok("b")], {}).shouldNotify, false);
});

test("diffState: entiende el formato VIEJO de estado (booleano)", () => {
  // Al desplegar el cambio, la caché trae el formato anterior: no debe perderse el contexto.
  expect_eq(diffState([down("a")], { a: false }).stillDown.includes("a"), true);
  expect_deep(diffState([ok("a")], { a: false }).recovered, ["a"]);
});

test("nextState: persiste fallos consecutivos y si ya se avisó", () => {
  const results = [down("a")];
  const d = diffState(results, { a: { fails: 1, alerted: false } });
  expect_deep(nextState(results, d), { a: { fails: 2, alerted: true } });
});

test("buildAlert: dice qué cayó y por qué importa", () => {
  const results = [down("vissed.com"), ok("smartrefresh.app")];
  // fails: 1 previo → este es el SEGUNDO fallo seguido, que es cuando se alerta.
  const msg = buildAlert(
    results,
    diffState(results, { "vissed.com": { fails: 1, alerted: false } }),
  );
  expect_match(msg, /CAÍDA/);
  expect_match(msg, /vissed\.com/);
  expect_match(msg, /Por qué importa/);
});

test("buildAlert: si fallan TODOS, apunta al edge compartido y no a un sitio", () => {
  // Fue exactamente el error de diagnóstico del 2026-08-08: parecía un problema de las extensiones.
  const results = TARGETS.map((t) => down(t.name));
  const previo = Object.fromEntries(
    TARGETS.map((t) => [t.name, { fails: 1, alerted: false }]),
  );
  const msg = buildAlert(results, diffState(results, previo));
  expect_match(msg, /edge compartido/);
  expect_match(msg, /infra_proxy/);
  expect_match(msg, /vps-infra\.md/);
});

test("buildAlert: con una sola caída NO culpa al edge", () => {
  const results = [
    down("vissed.com"),
    ok("smartrefresh.app"),
    ok("falcontrend.com"),
  ];
  const msg = buildAlert(results, diffState(results, {}));
  expect_nomatch(msg, /Fallan TODOS/);
});

test("buildAlert: edge caído con falcongrow sano SÍ culpa al edge (otro VPS)", () => {
  const results = TARGETS.map((t) =>
    t.edge === "compartido" ? down(t.name) : ok(t.name),
  );
  const previo = Object.fromEntries(
    TARGETS.map((t) => [t.name, { fails: 1, alerted: false }]),
  );
  expect_match(buildAlert(results, diffState(results, previo)), /Fallan TODOS/);
});

test("buildAlert: solo falcongrow caído NO culpa al edge", () => {
  const results = TARGETS.map((t) =>
    t.edge === "compartido" ? ok(t.name) : down(t.name),
  );
  const previo = Object.fromEntries(
    TARGETS.map((t) => [t.name, { fails: 1, alerted: false }]),
  );
  expect_nomatch(buildAlert(results, diffState(results, previo)), /Fallan TODOS/);
});

test("probe: página 200 SIN la cadena exigida → no sana, 'sin precio en el HTML'", async () => {
  const r = await probe(
    { name: "x", url: "https://x/", mustContain: "AggregateOffer" },
    { fetchImpl: async () => ({ status: 200, text: async () => "<html>sin schema</html>" }) },
  );
  expect_eq(r.status, 200);
  expect_eq(isHealthy(r), false);
  expect_match(r.error, /sin precio en el HTML/);
});

test("probe: página 200 CON la cadena exigida → sana", async () => {
  const r = await probe(
    { name: "x", url: "https://x/", mustContain: "AggregateOffer" },
    { fetchImpl: async () => ({ status: 200, text: async () => '{"@type":"AggregateOffer"}' }) },
  );
  expect_eq(isHealthy(r), true);
});

test("buildAlert: la alerta de contenido dice 'sin precio en el HTML'", async () => {
  const r = await probe(
    { name: "falcongrow.com/comprar", url: "https://x/", mustContain: "AggregateOffer" },
    { fetchImpl: async () => ({ status: 200, text: async () => "" }) },
  );
  const d = diffState([r], { "falcongrow.com/comprar": { fails: 1, alerted: false } });
  expect_match(buildAlert([r], d), /sin precio en el HTML/);
});

test("buildAlert: el mensaje de recuperación se distingue del de caída", () => {
  const results = [ok("vissed.com")];
  const msg = buildAlert(results, diffState(results, { "vissed.com": false }));
  expect_match(msg, /RECUPERADO/);
});

test("TARGETS: cubre los 3 dominios del edge + la URL que exige la CWS", () => {
  const names = TARGETS.map((t) => t.name);
  for (const d of ["smartrefresh.app", "vissed.com", "falcontrend.com", "falcongrow.com"]) {
    expect_ok(names.includes(d), `falta ${d}`);
  }
  expect_ok(names.some((n) => n.includes("privacy")));
  // Cada objetivo explica por qué importa: quien recibe la alerta de madrugada no debería
  // tener que abrir el código para saber si es urgente.
  for (const t of TARGETS)
    expect_ok(t.why && t.why.length > 20, `${t.name} sin "why"`);
});

test("telegramConfig: acepta los distintos alias que conviven en el portafolio", () => {
  expect(
    telegramConfig({ TG_BOT_TOKEN: "t", TG_CHAT_ID: "c" }).configured,
  ).toBe(true);
  expect(
    telegramConfig({ TELEGRAM_TOKEN: "t", TELEGRAM_CHAT_ID: "c" }).configured,
  ).toBe(true);
  // Sin token no se intenta enviar: el chequeo sigue sirviendo aunque falte la config.
  expect(telegramConfig({ TG_CHAT_ID: "c" }).configured).toBe(false);
  expect(telegramConfig({}).configured).toBe(false);
});

test("sendTelegram: sin configurar no lanza, informa y sigue", async () => {
  const { sendTelegram } = await import("./uptime-check.mjs");
  const out = await sendTelegram("hola", { env: {} });
  expect(out.sent).toBe(false);
});

test("CLI: no revienta — el camino que los unit tests no cubren", async () => {
  // Bug real: `nextState` se llamaba sin el `diff` y el CLI crasheaba con 28 tests en verde.
  // Los unit tests llaman a las funciones directo; nadie ejercitaba `main()`.
  //
  // La aserción es sobre stderr y NO sobre el código de salida ni sobre la red: el script sale con
  // 1 cuando un objetivo está caído, que es correcto, y esta prueba no debe depender de que haya
  // internet. Un crash de programación imprime "FALLO del chequeo:" y sale con 2 — eso es lo único
  // que se persigue acá. (La primera versión de este test miraba el archivo de estado y resultó
  // intermitente por un parpadeo de red: un test flaky es el mismo ruido que este monitor combate.)
  const { spawnSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");

  const statePath = path.join(tmpdir(), `uptime-clitest-${process.pid}.json`);
  const run = spawnSync(
    process.execPath,
    ["scripts/uptime-check.mjs", `--state=${statePath}`, "--no-notify"],
    { encoding: "utf8", timeout: 120000 },
  );

  expect(run.stderr ?? "", "el CLI lanzó una excepción").not.toMatch(
    /FALLO del chequeo/,
  );
  // 0 = todo sano · 1 = algún objetivo caído (ambos válidos). 2 = crash.
  expect([0, 1]).toContain(run.status);
});
