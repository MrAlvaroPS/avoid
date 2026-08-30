// Colocar en: src/app/features/guia-infografia/guia-infografia.component.ts
// §"página independiente con URL... sin navegación... que la gente no pueda
// navegar por ningún lado" (feedback real, 2026-08-30): guía para raiders
// sobre cómo leer su infografía de jugador — pensada para repartir como un
// enlace suelto en Discord, sin login y sin ningún routerLink de vuelta a la
// app (ver app.routes.ts/app.ts/app.html para el aislamiento de nav y
// bloqueo de móvil). Componente deliberadamente sin lógica: es texto fijo,
// no hay datos que cargar.
import { Component } from '@angular/core';

@Component({
  selector: 'app-guia-infografia',
  standalone: true,
  templateUrl: './guia-infografia.component.html',
  styleUrl: './guia-infografia.component.scss',
})
export class GuiaInfografiaComponent {}
