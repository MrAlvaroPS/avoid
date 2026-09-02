// Reexporta el contrato puro usado por Edge Functions. Mantener esta ruta
// estable evita que los componentes inventen enums o semántica causal propia.
export * from '../../../../supabase/functions/_shared/combat-evaluation-contract';

