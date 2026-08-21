// Colocar en: src/app/features/auth/sign-in.component.ts
// No hay pantalla de registro a propósito: el único usuario (tú) se crea una
// vez desde el Dashboard de Supabase (Authentication → Add user), ver SETUP.md.
import { Component, inject, signal } from '@angular/core';
import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'app-sign-in',
  standalone: true,
  templateUrl: './sign-in.component.html',
  styleUrl: './sign-in.component.scss',
})
export class SignInComponent {
  private auth = inject(AuthService);

  email = signal('');
  password = signal('');
  loading = signal(false);
  error = signal<string | null>(null);

  async onSubmit(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      await this.auth.signIn(this.email().trim(), this.password());
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
    }
  }
}
