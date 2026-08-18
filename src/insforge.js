import { createClient } from '@insforge/sdk';

// InsForge es un backend AI-native (alternativa a Supabase) que expone
// la base de datos, auth y storage mediante SDK y MCP, pensado para que
// agentes de IA (como Sora) puedan operar directamente sobre el backend.
const insforge = createClient({
  baseUrl: process.env.INSFORGE_URL,
  anonKey: process.env.INSFORGE_ANON_KEY,
});

export default insforge;

// Guardar orden en la tabla "ordenes" (el insert recibe un array,
// convencion del SDK de InsForge; ver AGENTS.md)
export async function guardarOrden({ clienteId, total, estado, metadata, moneda = 'mxn' }) {
  const { data, error } = await insforge
    .database
    .from('ordenes')
    .insert([{
      cliente_id: clienteId,
      total,
      estado,
      metadata,
      moneda,
      creado_en: new Date().toISOString(),
    }])
    .select()
    .single();

  if (error) throw error;
  return data;
}

// Obtener una orden por su id; devuelve null si no existe
export async function obtenerOrden(ordenId) {
  const { data, error } = await insforge
    .database
    .from('ordenes')
    .select('*')
    .eq('id', ordenId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

// Actualizar orden tras confirmar el pago (checkout.session.completed)
export async function confirmarPagoOrden(ordenId, stripeSessionId) {
  const { data, error } = await insforge
    .database
    .from('ordenes')
    .update({
      estado: 'pagada',
      stripe_session_id: stripeSessionId,
      pagado_en: new Date().toISOString(),
    })
    .eq('id', ordenId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

// Marcar la orden como fallida (payment_intent.payment_failed);
// devuelve null si la orden no existe
export async function marcarOrdenFallida(ordenId) {
  const { data, error } = await insforge
    .database
    .from('ordenes')
    .update({ estado: 'fallida' })
    .eq('id', ordenId)
    .select()
    .maybeSingle();

  if (error) throw error;
  return data;
}

// Marcar la orden como cancelada (checkout.session.expired);
// devuelve null si la orden no existe
export async function marcarOrdenCancelada(ordenId) {
  const { data, error } = await insforge
    .database
    .from('ordenes')
    .update({ estado: 'cancelada' })
    .eq('id', ordenId)
    .select()
    .maybeSingle();

  if (error) throw error;
  return data;
}