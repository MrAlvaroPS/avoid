import { Component, effect, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';

// §"vamos a preparar el login en este proyecto con discord, y que solo
// puedan continuar el login los que tengan el rol de Oficial en mi
// servidor" (feedback real, 2026-08-29): única puerta de entrada — el
// resto de rutas vive detrás de officerGuard (ver app.routes.ts), que
// redirige aquí. Dos estados de UI: sin sesión (botón de Discord) y
// logeado-pero-sin-rol (mensaje claro + cerrar sesión para probar otra
// cuenta), distinguidos por si hay session() a la vez que officerStatus()
// es 'denied'.
@Component({
  selector: 'app-login',
  standalone: true,
  imports: [],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
})
export class LoginComponent {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  constructor() {
    // Si ya eres Oficial (login recién completado, o ya lo eras y llegas
    // aquí a mano) no tiene sentido quedarse en /login — se va a donde
    // veníamos (redirectTo, ver officer.guard.ts) o a portada.
    effect(() => {
      if (this.auth.officerStatus() === 'officer') {
        const redirectTo = this.route.snapshot.queryParamMap.get('redirectTo');
        void this.router.navigateByUrl(redirectTo || '/');
      }
    });
  }

  onSignIn(): void {
    void this.auth.signInWithDiscord();
  }

  onSignOut(): void {
    void this.auth.signOut();
  }
}
