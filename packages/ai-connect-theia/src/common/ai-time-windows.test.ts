import { describe, expect, test } from 'bun:test';
import { isWithinWindows, parseTimeWindows } from './ai-time-windows';

// Reference weekdays (local time):
//   2026-01-05 = Monday (ISO 1)
//   2026-01-06 = Tuesday (ISO 2)
//   2026-01-10 = Saturday (ISO 6)
//   2026-01-11 = Sunday (ISO 7)
const mondayMorning = new Date(2026, 0, 5, 10, 30);
const mondayEvening = new Date(2026, 0, 5, 20, 0);
const saturdayNoon = new Date(2026, 0, 10, 12, 0);
const sundayNoon = new Date(2026, 0, 11, 12, 0);

describe('isWithinWindows — always available', () => {
  test('undefined windows are always available', () => {
    expect(isWithinWindows(undefined, mondayMorning)).toBe(true);
  });

  test('empty windows are always available', () => {
    expect(isWithinWindows([], mondayMorning)).toBe(true);
  });

  test('blank string entries are ignored (still always available)', () => {
    expect(isWithinWindows(['', '   '], mondayEvening)).toBe(true);
  });
});

describe('isWithinWindows — daily ranges', () => {
  test('inside a daily range', () => {
    expect(isWithinWindows(['09:00-18:00'], mondayMorning)).toBe(true);
  });

  test('outside a daily range', () => {
    expect(isWithinWindows(['09:00-18:00'], mondayEvening)).toBe(false);
  });

  test('end is exclusive', () => {
    expect(isWithinWindows(['09:00-10:30'], mondayMorning)).toBe(false);
  });

  test('start is inclusive', () => {
    expect(isWithinWindows(['10:30-18:00'], mondayMorning)).toBe(true);
  });

  test('union of multiple windows', () => {
    expect(isWithinWindows(['00:00-08:00', '19:00-23:00'], mondayEvening)).toBe(true);
    expect(isWithinWindows(['00:00-08:00', '19:00-23:00'], mondayMorning)).toBe(false);
  });
});

describe('isWithinWindows — weekday prefixes', () => {
  test('weekday range 1-5 includes Monday', () => {
    expect(isWithinWindows(['1-5 09:00-18:00'], mondayMorning)).toBe(true);
  });

  test('weekday range 1-5 excludes Saturday', () => {
    expect(isWithinWindows(['1-5 09:00-18:00'], saturdayNoon)).toBe(false);
  });

  test('weekday set 6,7 includes Saturday and Sunday', () => {
    expect(isWithinWindows(['6,7 10:00-14:00'], saturdayNoon)).toBe(true);
    expect(isWithinWindows(['6,7 10:00-14:00'], sundayNoon)).toBe(true);
  });

  test('weekday set 6,7 excludes Monday', () => {
    expect(isWithinWindows(['6,7 10:00-14:00'], mondayMorning)).toBe(false);
  });
});

describe('isWithinWindows — overnight ranges', () => {
  test('evening side of an overnight window', () => {
    // 22:00-06:00, Monday 20:00 is before the window
    expect(isWithinWindows(['22:00-06:00'], mondayEvening)).toBe(false);
    expect(isWithinWindows(['22:00-06:00'], new Date(2026, 0, 5, 23, 0))).toBe(true);
  });

  test('morning side of an overnight window', () => {
    expect(isWithinWindows(['22:00-06:00'], new Date(2026, 0, 5, 5, 0))).toBe(true);
    expect(isWithinWindows(['22:00-06:00'], new Date(2026, 0, 5, 6, 30))).toBe(false);
  });

  test('overnight window with weekday prefix applies to the START day', () => {
    // "5 22:00-06:00" = Friday night into Saturday morning (ISO 5 = Friday).
    // 2026-01-09 = Friday, 2026-01-10 = Saturday.
    const fridayNight = new Date(2026, 0, 9, 23, 30);
    const saturdayEarly = new Date(2026, 0, 10, 5, 0); // previous day is Friday
    const saturdayNight = new Date(2026, 0, 10, 23, 30); // start day would be Saturday, not Friday
    expect(isWithinWindows(['5 22:00-06:00'], fridayNight)).toBe(true);
    expect(isWithinWindows(['5 22:00-06:00'], saturdayEarly)).toBe(true);
    expect(isWithinWindows(['5 22:00-06:00'], saturdayNight)).toBe(false);
  });
});

describe('parseTimeWindows — malformed handling', () => {
  test('malformed entries flag a warning', () => {
    const parsed = parseTimeWindows(['garbage', '09:00-18:00']);
    expect(parsed.hasWarning).toBe(true);
    expect(parsed.malformed).toEqual(['garbage']);
    expect(parsed.windows).toHaveLength(1);
  });

  test('all-malformed list is treated as always available (fail-open)', () => {
    expect(isWithinWindows(['nonsense', '25:00-99:00'], mondayEvening)).toBe(true);
  });

  test('valid entries still gate when mixed with malformed', () => {
    // Only the valid 09:00-18:00 window applies; garbage is ignored.
    expect(isWithinWindows(['garbage', '09:00-18:00'], mondayEvening)).toBe(false);
    expect(isWithinWindows(['garbage', '09:00-18:00'], mondayMorning)).toBe(true);
  });

  test('rejects out-of-range clock values and equal start/end', () => {
    expect(parseTimeWindows(['24:00-25:00']).windows).toHaveLength(0);
    expect(parseTimeWindows(['12:00-12:00']).windows).toHaveLength(0);
    expect(parseTimeWindows(['9-1 09:00-10:00']).windows).toHaveLength(0);
  });
});
