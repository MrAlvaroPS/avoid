import { inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { Router, type CanActivateFn } from '@angular/router';
import { filter, map, take } from 'rxjs';
import { AuthService } from './auth.service';

// §"proteger todos los datos y rutas salvo que esté logeado un oficial, el
// resto no debería de poder ver nada" (feedback real, 2026-08-29): protege
// TODO el árbol de rutas salvo /login (ver app.routes.ts, un único nodo
// padre con este guard y las rutas existentes como children). Espera a que
// officerStatus() salga de 'unknown'/'checking' (getSession + la llamada a
// verify-officer son async) antes de decidir nada — dejar pasar la
// navegación mientras todavía no se sabe dejaría ver un instante de UI
// vacía/rota a quien no es Oficial (RLS bloquea los datos, pero no la
// propia pantalla).
export const officerGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return toObservable(auth.officerStatus).pipe(
    filter((status) => status === 'officer' || status === 'denied'),
    take(1),
    map((status) => (status === 'officer' ? true : router.createUrlTree(['/login'], { queryParams: { redirectTo: state.url } }))),
  );
};
