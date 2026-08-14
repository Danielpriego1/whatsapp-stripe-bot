import { createPaymentLink } from './stripe.js';
import { enviarMensaje } from './whatsapp.js';
import { guardarOrden, confirmarPagoOrden } from './insforge.js';

// Logica base de Sora (puedes expandir con IA despues)
export async function soraResponder(from, texto) {
  const textoLower = texto.toLowerCase();

  if (textoLower.includes('precio') || textoLower.includes('cotizar')) {
    return 'Claro, con gusto te ayudo con una cotizacion. Que producto o servicio te interesa?';
  }

  if (textoLower.includes('pagar') || textoLower.includes('comprar')) {
    const orden = await guardarOrden({
      clienteId: from,
      total: 50000,
      estado: 'pendiente',
      metadata: { producto: 'Servicio Grupo Psi' },
    });

    const paymentLink = await createPaymentLink({
      amount: 50000,
      currency: 'mxn',
      description: 'Servicio Grupo Psi',
      metadata: { ordenId: orden.id, cliente: from },
    });

    await enviarMensaje(
      from,
      `Aqui tienes tu enlace de pago: ${paymentLink}\nUna vez completado, te confirmamos por aqui.`
    );

    return 'Te acabo de enviar un enlace de pago. Necesitas ayuda con algo mas?';
  }

  return 'Gracias por contactarnos. Soy Sora, asistente de Grupo Psi. En que puedo ayudarte?';
}
