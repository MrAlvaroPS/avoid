import { errorMessage, isMissingSupabaseRelation } from './error-message.util';

describe('errorMessage', () => {
  it('muestra el mensaje de un error nativo', () => {
    expect(errorMessage(new Error('Fallo de red'))).toBe('Fallo de red');
  });

  it('extrae el mensaje y los detalles de un error plano de Supabase', () => {
    expect(errorMessage({ code: 'PGRST205', message: 'No se encontró la vista', details: 'Caché desactualizada', hint: null }))
      .toBe('No se encontró la vista · Caché desactualizada');
  });

  it('nunca convierte un objeto desconocido en [object Object]', () => {
    expect(errorMessage({ code: 'DESCONOCIDO' })).toBe('{"code":"DESCONOCIDO"}');
  });
});

describe('isMissingSupabaseRelation', () => {
  it('reconoce una relación ausente en la caché de PostgREST', () => {
    expect(isMissingSupabaseRelation(
      { code: 'PGRST205', message: "Could not find the table 'public.applicable_pull_mechanic_events' in the schema cache" },
      'applicable_pull_mechanic_events',
    )).toBe(true);
  });

  it('no oculta otros errores ni relaciones distintas', () => {
    expect(isMissingSupabaseRelation({ code: '42501', message: 'permission denied' }, 'applicable_pull_mechanic_events')).toBe(false);
    expect(isMissingSupabaseRelation({ code: 'PGRST205', message: 'missing another_view' }, 'applicable_pull_mechanic_events')).toBe(false);
  });
});
