import { createPaymentLink } from './stripe.js';
import { enviarMensaje } from './whatsapp.js';
import { guardarOrden } from './insforge.js';

// Dependencias inyectables para soraResponder (stubs en tests), mismo
// patron que procesarEvento en src/stripe.js.
const depsPorDefecto = {
  guardarOrden,
  createPaymentLink,
  enviarMensaje,
};

// Logica base de Sora (puedes expandir con IA despues).
// Devuelve { reply, alreadySent }:
//  - reply: texto a enviar por el llamador, o null si el mensaje ya fue
//    enviado dentro de esta llamada (rama de pago envia el link aqui).
//  - alreadySent: observabilidad para el llamador (true = el mensaje ya salio).
export async function soraResponder(from, texto, deps = depsPorDefecto) {
  const textoLower = texto.toLowerCase();

  if (textoLower.includes('precio') || textoLower.includes('cotizar')) {
    return {
      reply: 'Claro, con gusto te ayudo con una cotizacion. Que producto o servicio te interesa?',
      alreadySent: false,
    };
  }

  if (textoLower.includes('pagar') || textoLower.includes('comprar')) {
    const orden = await deps.guardarOrden({
      clienteId: from,
      total: 50000,
      estado: 'pendiente',
      moneda: 'mxn',
      metadata: { producto: 'Servicio Grupo Psi' },
    });

    const paymentLink = await deps.createPaymentLink({
      amount: 50000,
      currency: 'mxn',
      description: 'Servicio Grupo Psi',
      metadata: { ordenId: orden.id, cliente: from },
    });

    await deps.enviarMensaje(
      from,
      `Aqui tienes tu enlace de pago: ${paymentLink}\nUna vez completado, te confirmamos por aqui.`
    );

    // El enlace ya se envio aqui: reply null para que el llamador NO mande
    // un segundo mensaje (arregla el doble mensaje de pagar/comprar).
    return { reply: null, alreadySent: true };
  }

  return {
    reply: 'Gracias por contactarnos. Soy Sora, asistente de Grupo Psi. En que puedo ayudarte?',
    alreadySent: false,
  };
}
