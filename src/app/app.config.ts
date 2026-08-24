import { ApplicationConfig, LOCALE_ID, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { registerLocaleData } from '@angular/common';
import localeEs from '@angular/common/locales/es';

import { routes } from './app.routes';

// §bug real encontrado (2026-08-23, verificado en real: "19 de August,
// 2026" en el dosier de jugador): sin locale registrado, DatePipe (usado ya
// en boss-history/player-detail/el dosier — `| date: 'd MMM'` etc.) cae al
// default en_US de Angular pase lo que pase — nombres de mes en inglés en
// una app que por lo demás está toda en español. Se registra 'es' una vez
// aquí y se fija como LOCALE_ID del árbol entero.
registerLocaleData(localeEs);

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    { provide: LOCALE_ID, useValue: 'es' },
    // §boss-history usa :bossId/:difficulty como input() de ruta en vez de
    // leer ActivatedRoute a mano — necesita el binding automático de
    // Angular. No afecta a nada existente (ningún otro componente declara
    // un input que coincida con un nombre de parámetro de ruta).
    provideRouter(routes, withComponentInputBinding())
  ]
};
