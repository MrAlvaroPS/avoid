-- §"si contamos el pain suppression también deberíamos contabilizar la
-- Crisálida vital del monk" (feedback real, 2026-08-30): comprobado contra
-- producción antes de este cambio — Pain Suppression (Priest/Discipline,
-- external_defensive) SÍ estaba en cooldown_catalog; Life Cocoon (Monk/
-- Mistweaver) no tenía ninguna fila. No es una decisión deliberada de
-- excluirla: el catálogo se puebla por dos vías (una lista corta verificada
-- a mano el 21-08, ver 20260822030000_cooldown_catalog.sql — ahí entró Pain
-- Suppression a propósito — y una sincronización automática desde
-- WoWAnalyzer que solo sube lo que ESE proyecto etiqueta como defensivo en
-- su propio código) y Life Cocoon no entró por ninguna de las dos. Se añade
-- aquí con el mismo tratamiento que Pain Suppression: external_defensive
-- (protege a otro jugador, aunque también sea auto-lanzable) — el eje
-- ortogonal survival_type es 'absorption' (intercepta daño con un pool
-- aparte, ver comment de 20260827150000_defensive_survival_type.sql), no
-- 'sustain' como Word of Glory, porque no repara vida ya perdida: crea un
-- absorbedor nuevo.
--
-- Cooldown/duración verificados en vivo contra el tooltip real (Wowhead,
-- 2026-08-30, mismo endpoint que ya usa la app para iconos): "2 min
-- cooldown" / "Encases the target... for 12 sec, absorbing [...] damage" —
-- 120000ms/12000ms, el valor BASE sin contar la reducción de talento
-- opcional (sp202424, "1.3 min cooldown") — mismo criterio de "peor caso,
-- haste/talentos en 0" que ya usa el resto del catálogo (ver comentario de
-- extractBaseCooldownMs en supabase/wowanalyzer-extractor/extract.mjs).
-- reviewed=true porque es una confirmación humana explícita (este feedback),
-- no una sugerencia de IA sin revisar.
insert into cooldown_catalog (class, spec, spell_id, name, category, survival_type, base_cooldown_ms, base_duration_ms, reviewed)
values ('Monk', 'Mistweaver', 116849, 'Life Cocoon', 'external_defensive', 'absorption', 120000, 12000, true)
on conflict (class, spell_id) do nothing;
