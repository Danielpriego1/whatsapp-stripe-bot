// Tests unitarios para el webhook de Stripe (procesarEvento + ruta).
// Cobertura por caso de la matriz de amenazas de design.md:
// firma invalida, payload no confiable (sin ordenId, orden desconocida,
// discrepancia de monto/moneda), falla transitoria de DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

// Env de prueba (dummy) — debe setearse ANTES de importar src/stripe.js,
// que lee las claves al cargar el modulo.
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy123';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test123';
process.env.INSFORGE_URL = 'http://localhost:1';
process.env.INSFORGE_ANON_KEY = 'anon-dummy';
process.env.WHATSAPP_TOKEN = 'token-dummy';
process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
process.env.BASE_URL = 'http://localhost:3000';

const { procesarEvento, default: router } = await import('../src/stripe.js');

// Crea un stub de dependencias con rastreo de llamadas.
function crearDeps(overrides = {}) {
  const deps = {
    obtenerOrden: async () => null,
    confirmarPagoOrden: async () => ({}),
    marcarOrdenFallida: async () => ({}),
    marcarOrdenCancelada: async () => ({}),
    enviarMensaje: async () => ({}),
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

// Fabricacion de objetos de evento Stripe (objetos planos, sin SDK).
function eventoCheckoutCompletado(session) {
  return { type: 'checkout.session.completed', data: { object: session } };
}

function sessionCompletada(overrides = {}) {
  return {
    id: 'cs_123',
    amount_total: 50000,
    currency: 'mxn',
    metadata: { ordenId: '42' },
    ...overrides,
  };
}

function ordenBase(overrides = {}) {
  return {
    id: '42',
    cliente_id: '5215512345678',
    total: 50000,
    moneda: 'mxn',
    estado: 'pendiente',
    ...overrides,
  };
}

// Arranca el router de Stripe detras de un servidor HTTP real (mismo
// cableado que src/index.js: raw body + router).
async function arrancarServidor() {
  const app = express();
  app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));
  app.use('/webhooks/stripe', router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}/webhooks/stripe`;
  return {
    base,
    cerrar: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('ruta: firma invalida o ausente -> 400 y el evento nunca se procesa', async () => {
  const servidor = await arrancarServidor();
  try {
    const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });

    // Sin header stripe-signature
    const sinFirma = await fetch(servidor.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    assert.equal(sinFirma.status, 400, 'sin firma debe devolver 400');
    assert.match(await sinFirma.text(), /Webhook Error/, 'cuerpo debe explicar el error');

    // Firma invalida
    const firmaMala = await fetch(servidor.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 'tampered' },
      body: payload,
    });
    assert.equal(firmaMala.status, 400, 'firma invalida debe devolver 400');
    assert.match(await firmaMala.text(), /Webhook Error/);

    // En ningun caso debe responder 200 received:true (evento procesado)
    assert.notEqual(sinFirma.status, 200);
    assert.notEqual(firmaMala.status, 200);
  } finally {
    await servidor.cerrar();
  }
});

test('ruta: firma valida + evento desconocido -> 200 received:true (wiring OK)', async () => {
  const servidor = await arrancarServidor();
  try {
    const payload = JSON.stringify({ id: 'evt_2', type: 'evento.desconocido' });
    const header = (await import('stripe')).default.webhooks.generateTestHeaderString({
      payload,
      secret: process.env.STRIPE_WEBHOOK_SECRET,
    });
    const res = await fetch(servidor.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': header },
      body: payload,
    });
    assert.equal(res.status, 200, 'firma valida debe procesarse');
    assert.deepEqual(await res.json(), { received: true });
  } finally {
    await servidor.cerrar();
  }
});

test('completed sin metadata.ordenId -> ack 200, sin llamadas a DB ni WhatsApp', async () => {
  const obtenerOrden = rastrear();
  const confirmarPagoOrden = rastrear();
  const enviarMensaje = rastrear();
  const deps = crearDeps({ obtenerOrden, confirmarPagoOrden, enviarMensaje });

  const evento = eventoCheckoutCompletado(sessionCompletada({ metadata: undefined }));
  const resultado = await procesarEvento(evento, deps);

  assert.deepEqual(resultado, { status: 200 });
  assert.equal(obtenerOrden.llamadas.length, 0);
  assert.equal(confirmarPagoOrden.llamadas.length, 0);
  assert.equal(enviarMensaje.llamadas.length, 0);
});

test('completed con orden desconocida -> ack 200, sin cambio de estado', async () => {
  const confirmarPagoOrden = rastrear();
  const deps = crearDeps({ confirmarPagoOrden });

  const evento = eventoCheckoutCompletado(sessionCompletada());
  const resultado = await procesarEvento(evento, deps);

  assert.deepEqual(resultado, { status: 200 });
  assert.equal(confirmarPagoOrden.llamadas.length, 0);
});

test('completed con discrepancia de monto -> ack 200, la orden queda pendiente', async () => {
  const confirmarPagoOrden = rastrear();
  const deps = crearDeps({
    obtenerOrden: async () => ordenBase({ total: 99999 }),
    confirmarPagoOrden,
  });

  const evento = eventoCheckoutCompletado(sessionCompletada());
  const resultado = await procesarEvento(evento, deps);

  assert.deepEqual(resultado, { status: 200 });
  assert.equal(confirmarPagoOrden.llamadas.length, 0);
});

test('completed con discrepancia de moneda -> ack 200, la orden queda pendiente', async () => {
  const confirmarPagoOrden = rastrear();
  const deps = crearDeps({
    obtenerOrden: async () => ordenBase({ moneda: 'usd' }),
    confirmarPagoOrden,
  });

  const evento = eventoCheckoutCompletado(sessionCompletada());
  const resultado = await procesarEvento(evento, deps);

  assert.deepEqual(resultado, { status: 200 });
  assert.equal(confirmarPagoOrden.llamadas.length, 0);
});

test('completed con monto y moneda correctos -> pagada + confirmacion por WhatsApp', async () => {
  const confirmarPagoOrden = rastrear(async () => ordenBase({ estado: 'pagada' }));
  const enviarMensaje = rastrear();
  const deps = crearDeps({
    obtenerOrden: async () => ordenBase(),
    confirmarPagoOrden,
    enviarMensaje,
  });

  const evento = eventoCheckoutCompletado(sessionCompletada());
  const resultado = await procesarEvento(evento, deps);

  assert.deepEqual(resultado, { status: 200 });
  assert.deepEqual(confirmarPagoOrden.llamadas, [['42', 'cs_123']]);
  assert.equal(enviarMensaje.llamadas.length, 1);
  assert.equal(enviarMensaje.llamadas[0][0], '5215512345678');
  assert.equal(
    enviarMensaje.llamadas[0][1],
    '¡Gracias por tu compra! Tu pago fue confirmado.'
  );
});

test('completed duplicado (orden ya pagada) -> sin reenvio de WhatsApp', async () => {
  const enviarMensaje = rastrear();
  const deps = crearDeps({
    obtenerOrden: async () => ordenBase({ estado: 'pagada' }),
    confirmarPagoOrden: async () => ordenBase({ estado: 'pagada' }),
    enviarMensaje,
  });

  const evento = eventoCheckoutCompletado(sessionCompletada());
  const resultado = await procesarEvento(evento, deps);

  assert.deepEqual(resultado, { status: 200 });
  assert.equal(enviarMensaje.llamadas.length, 0, 'no debe reenviar en redelivery');
});

test('completed con falla transitoria de DB en update -> 500 (Stripe reintenta)', async () => {
  const deps = crearDeps({
    obtenerOrden: async () => ordenBase(),
    confirmarPagoOrden: async () => {
      throw new Error('connection refused');
    },
  });

  const evento = eventoCheckoutCompletado(sessionCompletada());
  const resultado = await procesarEvento(evento, deps);

  assert.deepEqual(resultado, { status: 500 });
});

test('completed con falla transitoria de DB en lectura -> 500 (Stripe reintenta)', async () => {
  const deps = crearDeps({
    obtenerOrden: async () => {
      throw new Error('timeout');
    },
  });

  const evento = eventoCheckoutCompletado(sessionCompletada());
  const resultado = await procesarEvento(evento, deps);

  assert.deepEqual(resultado, { status: 500 });
});

test('completed con fallo de WhatsApp -> se registra, la orden queda pagada, ack 200', async () => {
  const confirmarPagoOrden = rastrear(async () => ordenBase({ estado: 'pagada' }));
  const enviarMensaje = rastrear(async () => {
    throw new Error('WhatsApp API down');
  });
  const deps = crearDeps({
    obtenerOrden: async () => ordenBase(),
    confirmarPagoOrden,
    enviarMensaje,
  });

  const evento = eventoCheckoutCompletado(sessionCompletada());
  const resultado = await procesarEvento(evento, deps);

  assert.deepEqual(resultado, { status: 200 });
  assert.equal(confirmarPagoOrden.llamadas.length, 1, 'la orden queda pagada');
  assert.equal(enviarMensaje.llamadas.length, 1, 'el intento de envio ocurre');
});

test('payment_failed con ordenId en metadata -> orden marcada fallida', async () => {
  const marcarOrdenFallida = rastrear();
  const deps = crearDeps({ marcarOrdenFallida });

  const evento = {
    type: 'payment_intent.payment_failed',
    data: { object: { id: 'pi_123', metadata: { ordenId: '42' } } },
  };
  const resultado = await procesarEvento(evento, deps);

  assert.deepEqual(resultado, { status: 200 });
  assert.deepEqual(marcarOrdenFallida.llamadas, [['42']]);
});

test('payment_failed sin ordenId -> ack 200, sin cambios', async () => {
  const marcarOrdenFallida = rastrear();
  const deps = crearDeps({ marcarOrdenFallida });

  const evento = {
    type: 'payment_intent.payment_failed',
    data: { object: { id: 'pi_123', metadata: {} } },
  };
  const resultado = await procesarEvento(evento, deps);

  assert.deepEqual(resultado, { status: 200 });
  assert.equal(marcarOrdenFallida.llamadas.length, 0);
});

test('payment_failed con orden inexistente -> ack 200 (sin retry storm)', async () => {
  const marcarOrdenFallida = rastrear(async () => null);
  const deps = crearDeps({ marcarOrdenFallida });

  const evento = {
    type: 'payment_intent.payment_failed',
    data: { object: { id: 'pi_123', metadata: { ordenId: '999' } } },
  };
  const resultado = await procesarEvento(evento, deps);

  assert.deepEqual(resultado, { status: 200 });
});

test('payment_failed con falla transitoria de DB -> 500', async () => {
  const deps = crearDeps({
    marcarOrdenFallida: async () => {
      throw new Error('db down');
    },
  });

  const evento = {
    type: 'payment_intent.payment_failed',
    data: { object: { id: 'pi_123', metadata: { ordenId: '42' } } },
  };
  const resultado = await procesarEvento(evento, deps);

  assert.deepEqual(resultado, { status: 500 });
});

test('checkout.session.expired con ordenId -> orden marcada cancelada', async () => {
  const marcarOrdenCancelada = rastrear();
  const deps = crearDeps({ marcarOrdenCancelada });

  const evento = {
    type: 'checkout.session.expired',
    data: { object: { id: 'cs_123', metadata: { ordenId: '42' } } },
  };
  const resultado = await procesarEvento(evento, deps);

  assert.deepEqual(resultado, { status: 200 });
  assert.deepEqual(marcarOrdenCancelada.llamadas, [['42']]);
});

test('checkout.session.expired sin ordenId -> ack 200, sin cambios', async () => {
  const marcarOrdenCancelada = rastrear();
  const deps = crearDeps({ marcarOrdenCancelada });

  const evento = {
    type: 'checkout.session.expired',
    data: { object: { id: 'cs_123', metadata: {} } },
  };
  const resultado = await procesarEvento(evento, deps);

  assert.deepEqual(resultado, { status: 200 });
  assert.equal(marcarOrdenCancelada.llamadas.length, 0);
});

test('checkout.session.expired con falla transitoria de DB -> 500', async () => {
  const deps = crearDeps({
    marcarOrdenCancelada: async () => {
      throw new Error('db down');
    },
  });

  const evento = {
    type: 'checkout.session.expired',
    data: { object: { id: 'cs_123', metadata: { ordenId: '42' } } },
  };
  const resultado = await procesarEvento(evento, deps);

  assert.deepEqual(resultado, { status: 500 });
});

test('evento desconocido -> log + ack 200', async () => {
  const deps = crearDeps();
  const resultado = await procesarEvento({ type: 'charge.updated', data: { object: {} } }, deps);
  assert.deepEqual(resultado, { status: 200 });
});