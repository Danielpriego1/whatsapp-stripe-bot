import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export default supabase;

// Ejemplo: guardar orden
export async function guardarOrden({ clienteId, total, estado, metadata }) {
  const { data, error } = await supabase
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

// Ejemplo: actualizar orden tras pago
export async function confirmarPagoOrden(ordenId, stripeSessionId) {
  const { data, error } = await supabase
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
