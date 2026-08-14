import { createClient } from '@insforge/sdk';

// InsForge es un backend AI-native (alternativa a Supabase) que expone
// la base de datos, auth y storage mediante SDK y MCP, pensado para que
// agentes de IA (como Sora) puedan operar directamente sobre el backend.
const insforge = createClient({
  baseUrl: process.env.INSFORGE_URL,
  anonKey: process.env.INSFORGE_ANON_KEY,
});

export default insforge;

// Ejemplo: guardar orden en la tabla "ordenes"
export async function guardarOrden({ clienteId, total, estado, metadata }) {
  const { data, error } = await insforge
    .database
    .from('ordenes')
    .insert({
      cliente_id: clienteId,
      total,
      estado,
      metadata,
      creado_en: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

// Ejemplo: actualizar orden tras confirmar el pago
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
