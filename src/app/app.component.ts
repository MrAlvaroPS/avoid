// Reemplazar el contenido de: src/app/app.component.ts
import { Component, inject } from '@angular/core';
import { AuthService } from './core/auth.service';
import { SignInComponent } from './features/auth/sign-in.component';
import { RaidNightComponent } from './features/raid-night/raid-night.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [SignInComponent, RaidNightComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent {
  auth = inject(AuthService);
}
