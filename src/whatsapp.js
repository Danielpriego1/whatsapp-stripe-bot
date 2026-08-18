import express from 'express';
import axios from 'axios';
import { soraResponder } from './sora.js';

const router = express.Router();

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

// ---------------------------------------------------------------------------
// Dedupe de mensajes por message.id (Meta reintenta entregas fallidas).
// Ventana TTL de 10 minutos + tope de 5000 entradas; al desbordar se evicta
// la entrada mas antigua. In-memory: aceptable para un bot de una sola
// instancia (el estado se pierde al reiniciar).
// ---------------------------------------------------------------------------
const DEDUPE_TTL_MS = 10 * 60 * 1000;
const DEDUPE_CAP = 5000;
const procesados = new Map(); // messageId -> timestamp (ms)

// Sweep perezoso: descarta entradas vencidas al acceder.
export function yaProcesado(id) {
  const ahora = Date.now();
  for (const [clave, ts] of procesados) {
    if (ahora - ts > DEDUPE_TTL_MS) procesados.delete(clave);
  }
  return procesados.has(id);
}

// Marca el id como procesado; si se supera el tope, evicta la mas antigua.
export function marcarProcesado(id) {
  procesados.set(id, Date.now());
  if (procesados.size > DEDUPE_CAP) {
    const masAntigua = procesados.keys().next().value;
    procesados.delete(masAntigua);
  }
}

// ---------------------------------------------------------------------------
// Envio a la Graph API de Meta (endpoint /messages), compartido por
// enviarMensaje y marcarLeidoYEscritura.
// ---------------------------------------------------------------------------
export async function postGraphMessage(payload) {
  const url = `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`;
  const res = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

  return res.data;
}

// Envia un mensaje de texto por WhatsApp (firma sin cambios: la usa
// src/stripe.js para la confirmacion de pago).
export async function enviarMensaje(to, text) {
  return postGraphMessage({
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  });
}

// Indicador combinado: marca el mensaje como leido Y muestra el indicador de
// escritura en una sola llamada (forma documentada de Meta Cloud API:
// status 'read' + message_id + typing_indicator.type 'text'). No existe un
// 'typing_off': el indicador se auto-descarta al enviar la respuesta o a los
// 25 segundos.
export async function marcarLeidoYEscritura(from, messageId) {
  return postGraphMessage({
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
    typing_indicator: { type: 'text' },
  });
}

// ---------------------------------------------------------------------------
// Dependencias inyectables para procesarMensaje (stubs en tests), mismo
// patron que procesarEvento en src/stripe.js.
// ---------------------------------------------------------------------------
const depsPorDefecto = {
  soraResponder,
  enviarMensaje,
  marcarLeidoYEscritura,
};

// Procesa un mensaje entrante: indicador de lectura/escritura -> Sora ->
// envio de la respuesta (solo si soraResponder devuelve reply). Cada paso
// con su try/catch + log: un fallo nunca bloquea los demas mensajes.
export async function procesarMensaje(from, text, deps = depsPorDefecto, messageId = null) {
  if (!from || !text) return;

  // Indicador de lectura + escritura: falla -> se registra y se sigue (nunca
  // bloquea ni cancela la respuesta).
  try {
    await deps.marcarLeidoYEscritura(from, messageId);
  } catch (err) {
    console.error('Error enviando indicador de lectura/escritura:', err.message);
  }

  let resultado;
  try {
    resultado = await deps.soraResponder(from, text);
  } catch (err) {
    console.error('Error en soraResponder:', err.message);
    return;
  }

  // Solo se envia si hay reply; la rama de pago ya envio el link
  // (reply null + alreadySent true) y no debe mandar un segundo mensaje.
  if (resultado?.reply) {
    try {
      await deps.enviarMensaje(from, resultado.reply);
    } catch (err) {
      console.error('Error enviando respuesta por WhatsApp:', err.message);
    }
  }
}

// Webhook de WhatsApp (GET para verificacion, POST para mensajes)
router.get('/', (req, res) => {
  const mode = req.query['hub_mode'];
  const token = req.query['hub_verify_token'];
  const challenge = req.query['hub_challenge'];

  if (mode === 'subscribe' && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    console.log('Webhook verificado por Meta');
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Forbidden');
  }
});

// POST: ack inmediato (200 EVENT_RECEIVED) y procesamiento asincrono.
// Sin awaits en la ruta: si Meta esperara la respuesta, reintentaria y
// reprocesaria mensajes ya atendidos (el dedupe es la segunda defensa).
router.post('/', (req, res) => {
  const body = req.body ?? {};

  if (body.object !== 'whatsapp_business_account') {
    res.status(404).send('Not Found');
    return;
  }

  // Recorremos TODOS los mensajes del payload; por cada uno validamos y
  // marcamos como procesado ANTES del ack, para atrapar redeliveries que
  // compiten con el procesamiento en vuelo.
  const pendientes = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change.field !== 'messages') continue;
      for (const message of change.value?.messages ?? []) {
        const id = message?.id;
        const from = message?.from;
        const text = message?.text?.body;

        if (!id || !from || !text || yaProcesado(id)) continue;
        marcarProcesado(id);
        pendientes.push({ id, from, text });
      }
    }
  }

  // Ack inmediato: no espera al procesamiento
  res.status(200).send('EVENT_RECEIVED');

  // Fire-and-forget: procesamiento secuencial (limita el rate hacia Graph
  // API y evita 429s); cada mensaje contiene sus propios errores.
  void (async () => {
    for (const m of pendientes) {
      try {
        await procesarMensaje(m.from, m.text, depsPorDefecto, m.id);
      } catch (err) {
        console.error('Error procesando mensaje:', err.message);
      }
    }
  })();
});

export default router;