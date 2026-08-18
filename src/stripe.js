import express from 'express';
import Stripe from 'stripe';
import {
  obtenerOrden,
  confirmarPagoOrden,
  marcarOrdenFallida,
  marcarOrdenCancelada,
} from './insforge.js';
import { enviarMensaje } from './whatsapp.js';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Dependencias inyectables para procesarEvento (stubs en tests)
const depsPorDefecto = {
  obtenerOrden,
  confirmarPagoOrden,
  marcarOrdenFallida,
  marcarOrdenCancelada,
  enviarMensaje,
};

// Webhook de Stripe: wrapper delgado; la logica vive en procesarEvento
router.post('/', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Error verificando webhook de Stripe:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const resultado = await procesarEvento(event, depsPorDefecto);

  if (resultado.status === 500) {
    // Error transitorio: responder 500 para que Stripe reintente el evento
    return res.status(500).send('Error interno procesando evento');
  }

  res.json({ received: true });
});

// Procesa un evento de Stripe ya verificado. Devuelve { status }:
// 200 = ack (procesado o no recuperable, sin reintento),
// 500 = falla transitoria (Stripe debe reintentar).
export async function procesarEvento(event, deps) {
  switch (event.type) {
    case 'checkout.session.completed':
      return procesarCheckoutCompletado(event.data.object, deps);
    case 'payment_intent.payment_failed':
      return procesarPagoFallido(event.data.object, deps);
    case 'checkout.session.expired':
      return procesarSesionExpirada(event.data.object, deps);
    default:
      console.log(`Evento no manejado: ${event.type}`);
      return { status: 200 };
  }
}

// checkout.session.completed: verifica monto y moneda contra la orden
// antes de marcarla pagada y avisar al cliente por WhatsApp.
async function procesarCheckoutCompletado(session, deps) {
  const ordenId = session.metadata?.ordenId;
  if (!ordenId) {
    console.log(`checkout.session.completed sin metadata.ordenId: ${session.id}`);
    return { status: 200 };
  }

  let orden;
  try {
    orden = await deps.obtenerOrden(ordenId);
  } catch (err) {
    console.error('Error obteniendo orden:', err.message);
    return { status: 500 };
  }

  if (!orden) {
    console.log(`Orden no encontrada para checkout.session.completed: ${ordenId}`);
    return { status: 200 };
  }

  // Verificacion: el monto y la moneda de la sesion deben coincidir con la orden
  if (session.amount_total !== orden.total || session.currency !== orden.moneda) {
    console.log(
      `Discrepancia de pago: orden ${ordenId} esperaba ${orden.total} ${orden.moneda}, ` +
      `sesion ${session.amount_total} ${session.currency}`
    );
    return { status: 200 };
  }

  try {
    await deps.confirmarPagoOrden(ordenId, session.id);
  } catch (err) {
    console.error('Error confirmando pago:', err.message);
    return { status: 500 };
  }

  // Confirmacion por WhatsApp solo si la orden no estaba ya pagada
  // (evita mensajes duplicados en redelivery de Stripe)
  if (orden.estado !== 'pagada') {
    try {
      await deps.enviarMensaje(
        orden.cliente_id,
        '¡Gracias por tu compra! Tu pago fue confirmado.'
      );
    } catch (err) {
      // La orden ya quedo pagada; el fallo del mensaje solo se registra
      console.error('Error enviando confirmacion por WhatsApp:', err.message);
    }
  }

  return { status: 200 };
}

// payment_intent.payment_failed: marca la orden como fallida
async function procesarPagoFallido(paymentIntent, deps) {
  const ordenId = paymentIntent.metadata?.ordenId;
  if (!ordenId) {
    console.log(`payment_intent.payment_failed sin metadata.ordenId: ${paymentIntent.id}`);
    return { status: 200 };
  }

  try {
    const orden = await deps.marcarOrdenFallida(ordenId);
    if (!orden) {
      console.log(`Orden no encontrada para payment_intent.payment_failed: ${ordenId}`);
    }
  } catch (err) {
    console.error('Error marcando orden como fallida:', err.message);
    return { status: 500 };
  }

  return { status: 200 };
}

// checkout.session.expired: marca la orden como cancelada
async function procesarSesionExpirada(session, deps) {
  const ordenId = session.metadata?.ordenId;
  if (!ordenId) {
    console.log(`checkout.session.expired sin metadata.ordenId: ${session.id}`);
    return { status: 200 };
  }

  try {
    const orden = await deps.marcarOrdenCancelada(ordenId);
    if (!orden) {
      console.log(`Orden no encontrada para checkout.session.expired: ${ordenId}`);
    }
  } catch (err) {
    console.error('Error marcando orden como cancelada:', err.message);
    return { status: 500 };
  }

  return { status: 200 };
}

export async function createPaymentLink({ amount, currency = 'mxn', description, metadata = {} }) {
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency,
          unit_amount: amount,
          product_data: { name: description },
        },
        quantity: 1,
      },
    ],
    mode: 'payment',
    success_url: `${process.env.BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.BASE_URL}/cancel`,
    metadata,
    // El PaymentIntent tambien lleva la metadata (ordenId/cliente) para
    // resolver la orden en payment_intent.payment_failed
    payment_intent_data: { metadata },
  });

  return session.url;
}

export default router;