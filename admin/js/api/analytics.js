// Estadísticas: informe calculado por la base (public.analytics_report), que
// solo responde a administradores. Ver supabase/migrations/20261104000000_analytics.sql.
import { supabase } from "/js/lib/supabaseClient.js";

export async function getReport(from, to) {
  const { data, error } = await supabase.rpc("analytics_report", { p_from: from.toISOString(), p_to: to.toISOString() });
  if (error) throw error;
  return data;
}
