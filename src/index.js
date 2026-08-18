import 'dotenv/config';
import express from 'express';
import stripeRoutes from './stripe.js';
import whatsappRoutes from './whatsapp.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware para webhooks (raw body para Stripe)
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use('/webhooks/whatsapp', express.json());

// Rutas
app.use('/webhooks/stripe', stripeRoutes);
app.use('/webhooks/whatsapp', whatsappRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'whatsapp-stripe-bot' });
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
