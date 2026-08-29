import { Injectable, inject, signal } from '@angular/core';
import type { Session } from '@supabase/supabase-js';
import { SupabaseService } from './supabase.service';

export type OfficerStatus = 'unknown' | 'checking' | 'officer' | 'denied';

// §"solo puedan continuar el login los que tengan el rol de Oficial en mi
// servidor. Eso implica proteger todos los datos y rutas salvo que esté
// logeado un oficial" (feedback real, 2026-08-29): la sesión de Supabase
// (persistida en localStorage por defecto — supabase-js ya trae
// persistSession/autoRefreshToken activados, no se ha tocado esa
// configuración) solo dice "hay alguien logeado con Discord", nunca "es
// Oficial" — eso lo decide el bot de Discord contra
// discord_roster_channels_settings.officers_role_id, vía la Edge Function
// verify-officer (ver ese archivo). officerStatus() cachea ESE resultado
// para esta pestaña; el guard real y definitivo sigue siendo server-side
// (RLS + requireOfficer en cada Edge Function) — este signal es solo para
// decidir qué mostrar en la UI (login, "sin permiso" o la app).
//
// "que sea semi persistente... con que dure 1 mes o algo así es suficiente"
// (feedback real, 2026-08-29): auth.sessions.timebox/inactivity_timeout NO
// están configurados en supabase/config.toml (comentados por defecto), así
// que el refresh token no caduca por tiempo — la sesión persiste
// indefinidamente en este navegador mientras no se cierre sesión, más que
// de sobra para "un mes".
@Injectable({ providedIn: 'root' })
export class AuthService {
  private supabase = inject(SupabaseService);

  readonly session = signal<Session | null>(null);
  readonly officerStatus = signal<OfficerStatus>('unknown');

  constructor() {
    // §officerGuard espera a que officerStatus() salga de 'unknown'/'checking'
    // antes de decidir nada (ver ese archivo) — por eso una sesión ausente
    // también tiene que resolver a 'denied' explícitamente, no quedarse en
    // 'unknown' para siempre, o ningún guard llegaría a redirigir a /login.
    this.supabase.client.auth.getSession().then(({ data }) => {
      this.session.set(data.session);
      if (data.session) void this.verifyOfficer();
      else this.officerStatus.set('denied');
    });
    this.supabase.client.auth.onAuthStateChange((_event, session) => {
      const wasLoggedIn = !!this.session();
      this.session.set(session);
      if (!session) {
        this.officerStatus.set('denied');
      } else if (!wasLoggedIn) {
        void this.verifyOfficer();
      }
    });
  }

  async signInWithDiscord(): Promise<void> {
    await this.supabase.client.auth.signInWithOAuth({
      provider: 'discord',
      options: { redirectTo: window.location.origin },
    });
  }

  async signOut(): Promise<void> {
    await this.supabase.client.auth.signOut();
  }

  private async verifyOfficer(): Promise<void> {
    this.officerStatus.set('checking');
    try {
      const { data, error } = await this.supabase.client.functions.invoke<{ ok: boolean; isOfficer?: boolean; error?: string }>('verify-officer', { body: {} });
      if (error || !data?.ok) {
        this.officerStatus.set('denied');
        return;
      }
      this.officerStatus.set(data.isOfficer ? 'officer' : 'denied');
    } catch {
      this.officerStatus.set('denied');
    }
  }
}
