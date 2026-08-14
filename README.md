# whatsapp-stripe-bot

Bot de WhatsApp con pagos Stripe para Grupo Psi (IA Sora).

## Requisitos

- Node.js 18+
- Cuenta en Stripe
- WhatsApp Business Cloud API (Meta)
- Proyecto en InsForge (backend AI-native, alternativa a Supabase)

## Instalacion

```bash
git clone https://github.com/Danielpriego1/whatsapp-stripe-bot.git
cd whatsapp-stripe-bot
npm install
cp .env.example .env
# Edita .env con tus credenciales
```

## Ejecutar

```bash
npm start
# o en modo desarrollo:
npm run dev
```

## Despliegue en VPS

1. Sube el repo al VPS o haz git clone.
2. Instala Node.js y dependencias.
3. Configura .env.
4. Usa PM2:

```bash
pm2 start npm --name "whatsapp-stripe-bot" -- start
pm2 save
pm2 startup
```

5. Configura Nginx como reverse proxy (puerto 3000) y SSL con Let's Encrypt.

## Webhooks

- Stripe: POST /webhooks/stripe
- WhatsApp: POST /webhooks/whatsapp

Registra estas URLs en los dashboards de Stripe y Meta.

## Backend: InsForge

Este proyecto usa InsForge en lugar de Supabase porque expone la base de
datos, autenticacion y storage mediante un SDK y un servidor MCP pensado
para que agentes de IA (como Sora) puedan leer y escribir datos, crear
tablas y operar el backend directamente, sin intervencion manual.

Para conectar tu proyecto de InsForge, define en `.env`:

```
INSFORGE_URL=https://tu-proyecto.insforge.app
INSFORGE_ANON_KEY=your-anon-key
INSFORGE_API_KEY=your-api-key
```

Mas info: https://github.com/InsForge/insforge

## Estructura del proyecto

```
src/
  index.js      - Servidor Express principal
  stripe.js     - Integracion con Stripe (webhooks y payment links)
  whatsapp.js   - Integracion con WhatsApp Business Cloud API
  insforge.js   - Cliente de InsForge y funciones de ordenes
  sora.js       - Logica del asistente Sora
```
