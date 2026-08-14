import express from 'express';
import axios from 'axios';

const router = express.Router();

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

// Webhook de WhatsApp (GET para verificacion, POST para mensajes)
router.get('/', (req, res) => {
  const mode = req.query['hub_mode'];
  const token = req.query['hub_verify_token'];
  const challenge = req.query['hub_challenge'];

  if (mode === 'subscribe' && token === 'mi_token_secreto') {
    console.log('Webhook verificado por Meta');
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Forbidden');
  }
});

router.post('/', async (req, res) => {
  const body = req.body;

  if (body.object === 'whatsapp_business_account') {
    for (const entry of body.entry) {
      for (const change of entry.changes) {
        if (change.field === 'messages') {
          const message = change.value.messages?.[0];
          const from = message?.from;
          const text = message?.text?.body;

          if (from && text) {
            console.log(`Mensaje de ${from}: ${text}`);
            // Aqui integras con Sora
          }
        }
      }
    }
    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.status(404).send('Not Found');
  }
});

export async function enviarMensaje(to, text) {
  const url = `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  };

  const res = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

  return res.data;
}

export default router;
