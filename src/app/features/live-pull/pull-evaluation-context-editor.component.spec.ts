import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PullEvaluationContextEditorComponent } from './pull-evaluation-context-editor.component';
import { PullAnalysisService } from '../../core/pull-analysis.service';

// Mock type - mirrors the real contract
interface MockPullEvaluationContext {
  pullId: string;
  evaluationEligible: boolean;
  evaluationStartMs: number;
  evaluationEndMs: number;
  cutoffReason: 'fight_end' | 'wipe_call' | 'invalid_pull';
  wipeCallAtMs: number | null;
  wipeCallBossHpPct: number | null;
  wipeCallSource: string;
  wipeCallConfidence: number | null;
  wipeCallVerified: boolean;
  ninjaStatus: 'valid' | 'probable' | 'confirmed' | 'unknown';
  ninjaSource: string;
  ninjaConfidence: number | null;
  evidence: Record<string, unknown>;
  resolverVersion: string;
  updatedAt: string;
}

describe('PullEvaluationContextEditorComponent', () => {
  let component: PullEvaluationContextEditorComponent;
  let fixture: ComponentFixture<PullEvaluationContextEditorComponent>;
  let mockPullAnalysis: Partial<PullAnalysisService>;

  const mockContext: MockPullEvaluationContext = {
    pullId: 'pull-123',
    evaluationEligible: true,
    evaluationStartMs: 0,
    evaluationEndMs: 90_000,
    cutoffReason: 'fight_end',
    wipeCallAtMs: null,
    wipeCallBossHpPct: null,
    wipeCallSource: 'none',
    wipeCallConfidence: null,
    wipeCallVerified: false,
    ninjaStatus: 'valid',
    ninjaSource: 'imported',
    ninjaConfidence: null,
    evidence: {},
    resolverVersion: 'v1',
    updatedAt: new Date().toISOString(),
  };

  beforeEach(async () => {
    mockPullAnalysis = {
      setPullEvaluationContext: vi.fn().mockResolvedValue(undefined),
    };

    await TestBed.configureTestingModule({
      imports: [PullEvaluationContextEditorComponent],
      providers: [{ provide: PullAnalysisService, useValue: mockPullAnalysis }],
    }).compileComponents();

    fixture = TestBed.createComponent(PullEvaluationContextEditorComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('pullId', 'pull-123');
    fixture.componentRef.setInput('durationMs', 120_000);
    fixture.componentRef.setInput('context', mockContext as any);
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should open and close editor', () => {
    expect(component.isOpen()).toBe(false);
    component.openEditor();
    expect(component.isOpen()).toBe(true);
    component.closeEditor();
    expect(component.isOpen()).toBe(false);
  });

  it('should populate form with current context values', () => {
    component.openEditor();
    expect(component.evaluationStartSec()).toBe(0);
    expect(component.evaluationEndSec()).toBe(90);
    expect(component.wipeCallAtSec()).toBeNull();
    expect(component.ninjaConfirmed()).toBe(false);
  });

  it('should validate interval bounds', async () => {
    component.openEditor();
    component.evaluationEndSec.set(150); // Beyond duration
    component.overrideReason.set('test');
    
    await component.saveOverride();
    
    expect(component.error()).toContain('no está dentro de');
  });

  it('should require override reason', async () => {
    component.openEditor();
    component.evaluationStartSec.set(10);
    component.overrideReason.set('');
    
    await component.saveOverride();
    
    expect(component.error()).toContain('razón');
  });

  it('should format time display correctly', () => {
    expect(component.formatSeconds(0)).toBe('0:00');
    expect(component.formatSeconds(65)).toBe('1:05');
    expect(component.formatSeconds(3665)).toBe('1:01:05');
  });

  it('should detect context changes in summary', () => {
    component.openEditor();
    component.evaluationEndSec.set(100);
    
    const summary = component.formatContextChange();
    expect(summary).toContain('fin');
  });

  it('should emit contextChanged on successful save', async () => {
    const emitSpy = vi.spyOn(component.contextChanged, 'emit');
    
    component.openEditor();
    component.evaluationStartSec.set(10);
    component.overrideReason.set('Ajuste manual');
    
    await component.saveOverride();
    
    expect(emitSpy).toHaveBeenCalled();
  });

  it('should handle save errors gracefully', async () => {
    mockPullAnalysis.setPullEvaluationContext = vi
      .fn()
      .mockRejectedValue(new Error('API error'));

    component.openEditor();
    component.evaluationStartSec.set(10);
    component.overrideReason.set('test');
    
    await component.saveOverride();
    
    expect(component.error()).toContain('API error');
    expect(component.isOpen()).toBe(true);
  });

  it('should compute evaluable interval correctly', () => {
    const interval = component.evaluableIntervalMs();
    expect(interval.startMs).toBe(0);
    expect(interval.endMs).toBe(90_000);
    expect(interval.durationMs).toBe(90_000);
  });

  it('should label eligibility based on ninja status', () => {
    expect(component.evaluationEligibilityLabel()).toContain('Evaluable');

    fixture.componentRef.setInput('context', {
      ...mockContext,
      ninjaStatus: 'confirmed',
      evaluationEligible: false,
    } as any);
    fixture.detectChanges();
    
    expect(component.evaluationEligibilityLabel()).toContain('Ninja confirmado');
  });

  it('should extract wipe call candidate boundary correctly', () => {
    fixture.componentRef.setInput('context', {
      ...mockContext,
      evidence: { wipeCallCandidate: { boundaryMs: 45_000, confidence: 75 } },
    } as any);
    fixture.detectChanges();
    
    expect(component.getWipeCallCandidateBoundaryMs()).toBe(45_000);
  });

  it('should handle missing evidence gracefully', () => {
    fixture.componentRef.setInput('context', {
      ...mockContext,
      evidence: {},
    } as any);
    fixture.detectChanges();
    
    expect(component.getWipeCallCandidateBoundaryMs()).toBe(0);
  });
});
