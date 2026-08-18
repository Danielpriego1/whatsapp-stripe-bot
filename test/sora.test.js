// Tests del contrato estructurado de soraResponder: { reply, alreadySent }.
// Rama de pago -> reply null + alreadySent true (el enlace ya se envio aqui,
// el llamador NO debe mandar un segundo mensaje); rama normal -> reply string.
// Sigue el patron de test/stripe.test.js: env dummy antes del import,
// crearDeps/rastrear para inyectar stubs.
import test from 'node:test';
import assert from 'node:assert/strict';

// Env de prueba (dummy) — debe setearse ANTES de importar src/sora.js,
// que arrastra src/stripe.js (lee STRIPE_SECRET_KEY al cargar), src/whatsapp.js
// (lee WHATSAPP_TOKEN) y src/insforge.js (crea el cliente al cargar).
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy123';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test123';
process.env.INSFORGE_URL = 'http://localhost:1';
process.env.INSFORGE_ANON_KEY = 'anon-dummy';
process.env.WHATSAPP_TOKEN = 'token-dummy';
process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
process.env.BASE_URL = 'http://localhost:3000';

const { soraResponder } = await import('../src/sora.js');

// Crea un stub de dependencias con rastreo de llamadas.
function crearDeps(overrides = {}) {
  const deps = {
    guardarOrden: async () => ({ id: '42' }),
    createPaymentLink: async () => 'https://checkout.stripe.com/link-42',
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

test('pagar -> { reply: null, alreadySent: true } y el enlace se envia exactamente una vez', async () => {
  const guardarOrden = rastrear(async () => ({ id: '42' }));
  const createPaymentLink = rastrear(async () => 'https://checkout.stripe.com/link-42');
  const enviarMensaje = rastrear();
  const deps = crearDeps({ guardarOrden, createPaymentLink, enviarMensaje });

  const resultado = await soraResponder('5215512345678', 'quiero pagar', deps);

  assert.deepEqual(resultado, { reply: null, alreadySent: true });
  assert.equal(guardarOrden.llamadas.length, 1, 'crea la orden');
  assert.equal(createPaymentLink.llamadas.length, 1, 'crea el link de pago');
  assert.equal(enviarMensaje.llamadas.length, 1, 'el enlace se envia exactamente una vez');
  assert.match(enviarMensaje.llamadas[0][1], /checkout\.stripe\.com/, 'el enlace va en el mensaje');
});

test('comprar -> mismo contrato: reply null, alreadySent true, sin segundo envio', async () => {
  const enviarMensaje = rastrear();
  const deps = crearDeps({ enviarMensaje });

  const resultado = await soraResponder('5215512345678', 'quiero comprar', deps);

  assert.deepEqual(resultado, { reply: null, alreadySent: true });
  assert.equal(enviarMensaje.llamadas.length, 1);
});

test('precio/cotizar -> { reply: string, alreadySent: false } y NO envia aqui', async () => {
  const enviarMensaje = rastrear();
  const deps = crearDeps({ enviarMensaje });

  const resultado = await soraResponder('5215512345678', 'me das el precio?', deps);

  assert.equal(resultado.alreadySent, false);
  assert.equal(typeof resultado.reply, 'string');
  assert.match(resultado.reply, /cotizacion/i);
  assert.equal(enviarMensaje.llamadas.length, 0, 'el llamador envia la respuesta');
});

test('texto generico -> { reply: string, alreadySent: false }', async () => {
  const resultado = await soraResponder('5215512345678', 'hola, como estas?', crearDeps());

  assert.equal(resultado.alreadySent, false);
  assert.equal(typeof resultado.reply, 'string');
  assert.match(resultado.reply, /Sora/);
});