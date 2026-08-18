// Tests del webhook de WhatsApp (whatsapp.js): dedupe por message.id,
// ack-fast, procesamiento asincrono con contencion de errores y wiring POST.
// Cubre las filas de la matriz de amenazas de design.md: payload no confiable,
// falla de Graph API, redelivery duplicado. Patron de test/stripe.test.js:
// env dummy antes del import, crearDeps/rastrear, servidor HTTP real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import http from 'node:http';
import express from 'express';
import axios from 'axios';

// Env de prueba (dummy) — debe setearse ANTES de importar src/whatsapp.js.
// El import arrastra src/sora.js (y con el src/stripe.js y src/insforge.js),
// asi que se setean todas las claves que se leen al cargar.
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy123';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test123';
process.env.INSFORGE_URL = 'http://localhost:1';
process.env.INSFORGE_ANON_KEY = 'anon-dummy';
process.env.WHATSAPP_TOKEN = 'token-dummy';
process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
process.env.BASE_URL = 'http://localhost:3000';

const {
  yaProcesado,
  marcarProcesado,
  procesarMensaje,
  marcarLeidoYEscritura,
  default: router,
} = await import('../src/whatsapp.js');

// Crea un stub de dependencias para procesarMensaje (mismo patron que
// procesarEvento en test/stripe.test.js).
function crearDeps(overrides = {}) {
  const deps = {
    soraResponder: async () => ({ reply: 'respuesta de prueba', alreadySent: false }),
    enviarMensaje: async () => ({}),
    marcarLeidoYEscritura: async () => ({}),
    ...overrides,
  };
  return deps;
}

// Envuelve una funcion async para contar llamadas.
function rastrear(fn) {
  const llamadas = [];
  const stub = async (...args) => {
    llamadas.push(args);
    return fn ? fn(...args) : undefined;
  };
  stub.llamadas = llamadas;
  return stub;
}

// Espera (con polling) a que una condicion se cumpla; util para el
// procesamiento fire-and-forget posterior al ack.
async function esperarHasta(condicion, timeoutMs = 3000) {
  const inicio = Date.now();
  while (!condicion()) {
    if (Date.now() - inicio > timeoutMs) {
      throw new Error('timeout esperando condicion');
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// Fabricacion de deliveries de WhatsApp (objetos planos).
function mensaje(id, overrides = {}) {
  return {
    id,
    from: '5215512345678',
    timestamp: '1720000000',
    type: 'text',
    text: { body: 'hola' },
    ...overrides,
  };
}

function delivery(messages, overrides = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: [{ field: 'messages', value: { messages } }],
      },
    ],
    ...overrides,
  };
}

// Arranca el router de WhatsApp detras de un servidor HTTP real (mismo
// cableado que src/index.js: express.json + router).
async function arrancarServidor() {
  const app = express();
  app.use('/webhooks/whatsapp', express.json());
  app.use('/webhooks/whatsapp', router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}/webhooks/whatsapp`;
  return {
    base,
    cerrar: () => new Promise((resolve) => server.close(resolve)),
  };
}

function postear(servidor, body) {
  return fetch(servidor.base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Dedupe por message.id (RED: helpers yaProcesado/marcarProcesado)
// ---------------------------------------------------------------------------

test('dedupe: mismo id dentro de la ventana -> yaProcesado true; id nuevo -> false', () => {
  marcarProcesado('dedupe-1');
  assert.equal(yaProcesado('dedupe-1'), true, 'id marcado se reconoce');
  assert.equal(yaProcesado('dedupe-2'), false, 'id nuevo no esta marcado');
});

test('dedupe: id pasado el TTL (10 min) -> yaProcesado vuelve a false', () => {
  mock.timers.enable({ apis: ['Date'] });
  try {
    marcarProcesado('dedupe-ttl');
    assert.equal(yaProcesado('dedupe-ttl'), true);

    // Dentro de la ventana sigue marcado
    mock.timers.tick(9 * 60 * 1000);
    assert.equal(yaProcesado('dedupe-ttl'), true, 'aun dentro del TTL');

    // Supera los 10 minutos -> vuelve a estar disponible
    mock.timers.tick(60 * 1000 + 1);
    assert.equal(yaProcesado('dedupe-ttl'), false, 'vencio el TTL');
  } finally {
    mock.timers.reset();
  }
});

test('dedupe: cap 5000 evicta la entrada mas antigua al desbordar', () => {
  for (let i = 0; i < 5000; i++) {
    marcarProcesado(`dedupe-cap-${i}`);
  }
  // Llenamos hasta el tope: la mas antigua sigue viva
  assert.equal(yaProcesado('dedupe-cap-0'), true, 'dentro de la capacidad');

  // Una entrada mas desborda -> se evicta la mas antigua (insercion mas vieja)
  marcarProcesado('dedupe-cap-overflow');
  assert.equal(yaProcesado('dedupe-cap-0'), false, 'la mas antigua se evicta');
  assert.equal(yaProcesado('dedupe-cap-overflow'), true, 'la nueva entra');
});

// ---------------------------------------------------------------------------
// procesarMensaje: contencion de errores (RED) + contrato de envio
// ---------------------------------------------------------------------------

test('procesarMensaje: soraResponder falla -> se registra y no lanza', async () => {
  const soraResponder = rastrear(async () => {
    throw new Error('sora boom');
  });
  const enviarMensaje = rastrear();
  const deps = crearDeps({ soraResponder, enviarMensaje });

  await procesarMensaje('5215512345678', 'hola', deps, 'pm-1');

  assert.equal(soraResponder.llamadas.length, 1);
  assert.equal(enviarMensaje.llamadas.length, 0, 'sin respuesta si Sora falla');
});

test('procesarMensaje: enviarMensaje rechaza -> se registra, el siguiente mensaje sigue', async () => {
  const enviarMensajeMal = rastrear(async () => {
    throw new Error('WhatsApp API down');
  });
  const depsMal = crearDeps({
    soraResponder: async () => ({ reply: 'primera', alreadySent: false }),
    enviarMensaje: enviarMensajeMal,
  });

  // Primer mensaje: el envio falla pero procesarMensaje no lanza
  await procesarMensaje('5215512345678', 'hola', depsMal, 'pm-2');

  const enviarMensajeOk = rastrear();
  const depsOk = crearDeps({
    soraResponder: async () => ({ reply: 'segunda', alreadySent: false }),
    enviarMensaje: enviarMensajeOk,
  });

  // Segundo mensaje: se procesa y se envia con normalidad
  await procesarMensaje('5215512345678', 'que precio?', depsOk, 'pm-3');

  assert.equal(enviarMensajeMal.llamadas.length, 1, 'el intento fallido ocurre');
  assert.equal(enviarMensajeOk.llamadas.length, 1, 'el siguiente mensaje se procesa');
  assert.deepEqual(enviarMensajeOk.llamadas[0], ['5215512345678', 'segunda']);
});

test('procesarMensaje: falla el indicador de lectura/escritura -> la respuesta se envia igual', async () => {
  const marcarLeidoYEscritura = rastrear(async () => {
    throw new Error('indicator down');
  });
  const enviarMensaje = rastrear();
  const deps = crearDeps({
    marcarLeidoYEscritura,
    enviarMensaje,
    soraResponder: async () => ({ reply: 'si, claro', alreadySent: false }),
  });

  await procesarMensaje('5215512345678', 'hola', deps, 'pm-4');

  assert.equal(marcarLeidoYEscritura.llamadas.length, 1);
  assert.equal(enviarMensaje.llamadas.length, 1, 'la respuesta llega pese al fallo del indicador');
  assert.deepEqual(enviarMensaje.llamadas[0], ['5215512345678', 'si, claro']);
});

test('procesarMensaje: indicador y respuesta se envian en orden (indicador primero)', async () => {
  const marcarLeidoYEscritura = rastrear();
  const enviarMensaje = rastrear();
  const deps = crearDeps({ marcarLeidoYEscritura, enviarMensaje });

  await procesarMensaje('5215512345678', 'hola', deps, 'pm-orden');

  assert.deepEqual(marcarLeidoYEscritura.llamadas[0], ['5215512345678', 'pm-orden']);
  assert.equal(enviarMensaje.llamadas.length, 1);
});

test('procesarMensaje: resultado sin reply (pago ya enviado) -> no envia segundo mensaje', async () => {
  const enviarMensaje = rastrear();
  const deps = crearDeps({
    soraResponder: async () => ({ reply: null, alreadySent: true }),
    enviarMensaje,
  });

  await procesarMensaje('5215512345678', 'pagar', deps, 'pm-5');

  assert.equal(enviarMensaje.llamadas.length, 0, 'no hay doble mensaje en la rama de pago');
});

test('procesarMensaje: sin from o sin texto -> no hace nada', async () => {
  const soraResponder = rastrear();
  const enviarMensaje = rastrear();
  const deps = crearDeps({ soraResponder, enviarMensaje });

  await procesarMensaje(null, 'hola', deps, 'pm-6');
  await procesarMensaje('5215512345678', '', deps, 'pm-7');
  await procesarMensaje('5215512345678', undefined, deps, 'pm-8');

  assert.equal(soraResponder.llamadas.length, 0, 'sin from/texto no se llama a Sora');
  assert.equal(enviarMensaje.llamadas.length, 0);
});

// ---------------------------------------------------------------------------
// Wiring POST (integration): ack-fast, multi-mensaje, skip, 404, redelivery
// ---------------------------------------------------------------------------

test('ruta: acks 200 EVENT_RECEIVED antes de que termine el procesamiento', async () => {
  // El stub de axios queda pendiente: si la respuesta llega igual, el handler
  // no espera al procesamiento (ack-fast, sin awaits en la ruta).
  let resolverPendiente;
  const pendiente = new Promise((resolve) => {
    resolverPendiente = resolve;
  });
  const post = mock.method(axios, 'post', () => pendiente);
  let servidor;
  try {
    servidor = await arrancarServidor();
    const respuesta = await postear(servidor, delivery([mensaje('ack-1')]));

    assert.equal(respuesta.status, 200);
    assert.equal(await respuesta.text(), 'EVENT_RECEIVED');
    assert.ok(post.mock.callCount() >= 1, 'el procesamiento arranco despues del ack');

    resolverPendiente({ data: {} });
    await esperarHasta(() => post.mock.callCount() >= 2);
  } finally {
    resolverPendiente?.({ data: {} });
    mock.restoreAll();
    await servidor.cerrar();
  }
});

test('ruta: payload multi-mensaje -> cada mensaje con indicador y respuesta', async () => {
  const post = mock.method(axios, 'post', async () => ({ data: {} }));
  let servidor;
  try {
    servidor = await arrancarServidor();
    const respuesta = await postear(servidor, delivery([
      mensaje('multi-1', { text: { body: 'hola' } }),
      mensaje('multi-2', { text: { body: 'me das el precio?' } }),
    ]));

    assert.equal(respuesta.status, 200);
    // 2 indicadores + 2 respuestas, en orden secuencial por mensaje
    await esperarHasta(() => post.mock.callCount() >= 4);
    const payloads = post.mock.calls.map((llamada) => llamada.arguments[1]);

    assert.equal(payloads[0].status, 'read');
    assert.equal(payloads[0].message_id, 'multi-1');
    assert.equal(payloads[0].typing_indicator.type, 'text');
    assert.equal(payloads[1].type, 'text');
    assert.equal(payloads[2].status, 'read');
    assert.equal(payloads[2].message_id, 'multi-2');
    assert.equal(payloads[3].type, 'text');
  } finally {
    mock.restoreAll();
    await servidor.cerrar();
  }
});

test('ruta: mensaje sin from o sin texto -> se salta, sin respuestas, ack 200', async () => {
  const post = mock.method(axios, 'post', async () => ({ data: {} }));
  let servidor;
  try {
    servidor = await arrancarServidor();
    const respuesta = await postear(servidor, delivery([
      mensaje('skip-1', { text: { body: 'hola' } }),
      { id: 'skip-2', text: { body: 'sin from' } }, // falta from
      { id: 'skip-3', from: '5215512345678', text: {} }, // texto vacio
      { id: 'skip-4', from: '5215512345678' }, // sin text
    ]));

    assert.equal(respuesta.status, 200);
    await esperarHasta(() => post.mock.callCount() >= 2);
    assert.equal(post.mock.callCount(), 2, 'solo skip-1 se procesa (indicador + respuesta)');
  } finally {
    mock.restoreAll();
    await servidor.cerrar();
  }
});

test('ruta: redelivery del mismo message.id -> procesado una sola vez, sin efectos', async () => {
  const post = mock.method(axios, 'post', async () => ({ data: {} }));
  let servidor;
  try {
    servidor = await arrancarServidor();
    const payload = delivery([mensaje('dup-1')]);

    const primera = await postear(servidor, payload);
    assert.equal(primera.status, 200);
    await esperarHasta(() => post.mock.callCount() >= 2);

    // Mismo message.id: Meta reintento dentro de la ventana de dedupe
    const segunda = await postear(servidor, payload);
    assert.equal(segunda.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(post.mock.callCount(), 2, 'el duplicado no genera efectos');
  } finally {
    mock.restoreAll();
    await servidor.cerrar();
  }
});

test('ruta: objeto que no es whatsapp_business_account -> 404', async () => {
  const post = mock.method(axios, 'post', async () => ({ data: {} }));
  let servidor;
  try {
    servidor = await arrancarServidor();
    const respuesta = await postear(servidor, { object: 'instagram_business_account', entry: [] });

    assert.equal(respuesta.status, 404);
    assert.equal(post.mock.callCount(), 0, 'no procesa nada');
  } finally {
    mock.restoreAll();
    await servidor.cerrar();
  }
});

test('ruta: payload malformado (sin entry) -> 200, nunca lanza', async () => {
  const post = mock.method(axios, 'post', async () => ({ data: {} }));
  let servidor;
  try {
    servidor = await arrancarServidor();
    const respuesta = await postear(servidor, { object: 'whatsapp_business_account' });

    assert.equal(respuesta.status, 200);
    assert.equal(await respuesta.text(), 'EVENT_RECEIVED');
    assert.equal(post.mock.callCount(), 0);
  } finally {
    mock.restoreAll();
    await servidor.cerrar();
  }
});

test('ruta: falla el indicador de Graph -> la respuesta se envia igual (y 200)', async () => {
  let llamada = 0;
  const post = mock.method(axios, 'post', async () => {
    llamada++;
    if (llamada === 1) throw new Error('Graph API down'); // falla el indicador
    return { data: {} };
  });
  let servidor;
  try {
    servidor = await arrancarServidor();
    const respuesta = await postear(servidor, delivery([mensaje('ind-1')]));

    assert.equal(respuesta.status, 200);
    await esperarHasta(() => post.mock.callCount() >= 2);
    const payloads = post.mock.calls.map((c) => c.arguments[1]);
    assert.equal(payloads[1].type, 'text', 'la respuesta llega pese al fallo del indicador');
  } finally {
    mock.restoreAll();
    await servidor.cerrar();
  }
});

// ---------------------------------------------------------------------------
// marcarLeidoYEscritura: payload combinado documentado de Meta Cloud API
// ---------------------------------------------------------------------------

test('marcarLeidoYEscritura: payload combinado read + typing_indicator', async () => {
  const post = mock.method(axios, 'post', async () => ({ data: {} }));
  try {
    const resultado = await marcarLeidoYEscritura('5215512345678', 'msg-abc');

    assert.equal(post.mock.callCount(), 1);
    const [url, payload] = post.mock.calls[0].arguments;
    assert.match(url, /graph\.facebook\.com\/v17\.0\/1234567890\/messages/);
    assert.deepEqual(payload, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'msg-abc',
      typing_indicator: { type: 'text' },
    });
    assert.ok(resultado);
  } finally {
    mock.restoreAll();
  }
});