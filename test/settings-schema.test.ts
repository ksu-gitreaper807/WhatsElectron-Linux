import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  SETTING_FIELDS,
  isValidAccelerator,
  mergeSettings,
  normalizeSettings,
  validateSettings,
} from '../src/shared/settings.js';

describe('settings schema', () => {
  it('describes every key of AppSettings exactly once', () => {
    const keys = SETTING_FIELDS.map((field) => field.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      expect(keys).toContain(key);
    }
  });

  it('declares defaults that agree with the field metadata', () => {
    for (const field of SETTING_FIELDS) {
      expect(field.default).toBe(DEFAULT_SETTINGS[field.key]);
      if (field.type === 'integer' && field.min !== undefined && field.max !== undefined) {
        const value = DEFAULT_SETTINGS[field.key] as number;
        expect(value).toBeGreaterThanOrEqual(field.min);
        expect(value).toBeLessThanOrEqual(field.max);
      }
      if (field.type === 'enum') {
        expect(field.options).toContain(DEFAULT_SETTINGS[field.key] as string);
      }
    }
  });

  it('accepts sane values and returns them unchanged', () => {
    const { value, issues } = validateSettings({
      dndEnabled: true,
      groupingIntervalMs: 2_000,
      notificationBackend: 'dbus',
      globalShortcut: 'Super+Alt+W',
    });
    expect(issues).toEqual([]);
    expect(value).toEqual({
      dndEnabled: true,
      groupingIntervalMs: 2_000,
      notificationBackend: 'dbus',
      globalShortcut: 'Super+Alt+W',
    });
  });

  it('drops unknown keys with a message instead of persisting them', () => {
    const { value, issues } = validateSettings({ injected: 1, dndEnabled: true });
    expect(value).toEqual({ dndEnabled: true });
    expect(issues).toContainEqual({ key: 'injected', message: 'unknown setting' });
  });

  it('rejects wrong types rather than coercing them', () => {
    const cases: readonly [string, unknown][] = [
      ['dndEnabled', 'true'],
      ['dndEnabled', 1],
      ['groupingIntervalMs', 1.5],
      ['groupingIntervalMs', '5000'],
      ['groupingIntervalMs', Number.NaN],
      ['groupingIntervalMs', Number.POSITIVE_INFINITY],
      ['notificationBackend', 'telepathy'],
      ['globalShortcut', 42],
    ];
    for (const [key, bad] of cases) {
      const { value, issues } = validateSettings({ [key]: bad });
      expect((value as Record<string, unknown>)[key], `${key}=${String(bad)}`).toBeUndefined();
      expect(issues.length, key).toBeGreaterThan(0);
    }
  });

  it('enforces the declared integer range', () => {
    expect(validateSettings({ groupingIntervalMs: 499 }).issues.length).toBe(1);
    expect(validateSettings({ groupingIntervalMs: 60_001 }).issues.length).toBe(1);
    expect(validateSettings({ groupingIntervalMs: 500 }).issues).toEqual([]);
  });

  it('refuses an enabled shortcut with no valid accelerator, and drops only the shortcut', () => {
    const { value, issues } = validateSettings({ globalShortcut: 'W', globalShortcutEnabled: true });
    expect(value['globalShortcut']).toBeUndefined();
    expect(value['globalShortcutEnabled']).toBe(true);
    expect(issues.some((issue) => issue.key === 'globalShortcut')).toBe(true);
  });

  it('allows clearing the accelerator only when the shortcut is off', () => {
    expect(
      validateSettings({ globalShortcut: '' }, { ...DEFAULT_SETTINGS, globalShortcutEnabled: false }).issues,
    ).toEqual([]);
    const strict = validateSettings({ globalShortcut: '' }, { ...DEFAULT_SETTINGS, globalShortcutEnabled: true });
    expect(strict.issues.length).toBe(0); // '' means "disabled but configured": nothing to apply
  });

  describe('accelerator grammar', () => {
    const valid = [
      'Ctrl+Shift+W',
      'Super+Alt+W',
      'CommandOrControl+Space',
      'Ctrl+Plus',
      'Alt+F2',
      'Ctrl+Shift+Escape',
      'Super+1',
      'Ctrl+`',
      'ctrl + shift + w',
      'CmdOrCtrl+Shift+/',
    ];
    const invalid = [
      '',
      'W',
      'Control',
      'Ctrl',
      'Ctrl+',
      'Ctrl+Shift+W+X',
      'F12',
      'NotAModifier+X',
      'Ctrl+NotAKey',
      'x'.repeat(200),
      42,
      null,
    ];

    it.each(valid)('accepts %s', (input) => {
      expect(isValidAccelerator(input)).toBe(true);
    });

    it.each(invalid)('rejects %s', (input) => {
      expect(isValidAccelerator(input)).toBe(false);
    });
  });

  it('rejects non-objects wholesale', () => {
    for (const junk of [null, undefined, 5, 'x', []]) {
      const { value, issues } = validateSettings(junk);
      expect(value).toEqual({});
      expect(issues.length).toBeGreaterThan(0);
    }
  });

  it('normalizeSettings fills every default from a partial file', () => {
    const settings = normalizeSettings({ dndEnabled: true, garbage: 1 });
    expect(settings.dndEnabled).toBe(true);
    expect(settings.groupingIntervalMs).toBe(DEFAULT_SETTINGS.groupingIntervalMs);
    expect(Object.keys(settings).length).toBe(Object.keys(DEFAULT_SETTINGS).length);
  });

  it('mergeSettings ignores undefined but keeps false', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { dndEnabled: false, startOnLogin: undefined });
    expect(merged.dndEnabled).toBe(false);
    expect(merged.startOnLogin).toBe(DEFAULT_SETTINGS.startOnLogin);
  });

  it('returns frozen objects so nothing can mutate the shared defaults', () => {
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
    expect(Object.isFrozen(mergeSettings(DEFAULT_SETTINGS, { dndEnabled: true }))).toBe(true);
  });
});
