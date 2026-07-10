/**
 * Pure availability-window parsing/matching for AI endpoints.
 *
 * A time window is a compact string:
 *   "09:00-18:00"            daily time range (every weekday)
 *   "1-5 09:00-18:00"        ISO weekday range prefix (1=Mon .. 7=Sun) + range
 *   "6,7 10:00-14:00"        ISO weekday set prefix + range
 *   "22:00-06:00"            overnight range (wraps past midnight)
 *
 * An empty/absent window list means "always available". Malformed entries are
 * skipped with a warning flag; when every entry is malformed the endpoint is
 * treated as always available (fail-open, never silently unreachable).
 *
 * All matching is done in the local timezone, since availability windows are a
 * human, wall-clock concept.
 */

export interface ParsedTimeWindow {
  /** ISO weekdays (1=Mon .. 7=Sun) the window's START day applies to; undefined = every day. */
  weekdays?: Set<number>;
  /** Minutes-since-midnight of the window start (0..1439). */
  startMinutes: number;
  /** Minutes-since-midnight of the window end (0..1439); < start means overnight. */
  endMinutes: number;
  /** The trimmed source string. */
  raw: string;
}

export interface ParsedTimeWindows {
  /** Successfully parsed windows (union of availability). */
  windows: ParsedTimeWindow[];
  /** Raw entries that failed to parse. */
  malformed: string[];
  /** True when at least one entry was malformed. */
  hasWarning: boolean;
}

function weekdayIso(date: Date): number {
  const day = date.getDay(); // 0=Sun .. 6=Sat
  return day === 0 ? 7 : day;
}

function previousWeekdayIso(iso: number): number {
  return iso === 1 ? 7 : iso - 1;
}

function parseWeekdays(spec: string): Set<number> | undefined {
  const result = new Set<number>();
  for (const rawToken of spec.split(',')) {
    const token = rawToken.trim();
    if (!token) {
      return undefined;
    }
    const range = /^([1-7])-([1-7])$/.exec(token);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from > to) {
        return undefined;
      }
      for (let day = from; day <= to; day += 1) {
        result.add(day);
      }
      continue;
    }
    if (/^[1-7]$/.test(token)) {
      result.add(Number(token));
      continue;
    }
    return undefined;
  }
  return result.size > 0 ? result : undefined;
}

function parseWindow(raw: string): ParsedTimeWindow | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const parts = trimmed.split(/\s+/);
  let weekdays: Set<number> | undefined;
  let timeSpec: string;
  if (parts.length === 1) {
    timeSpec = parts[0];
  } else if (parts.length === 2) {
    weekdays = parseWeekdays(parts[0]);
    if (!weekdays) {
      return undefined;
    }
    timeSpec = parts[1];
  } else {
    return undefined;
  }

  const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(timeSpec);
  if (!match) {
    return undefined;
  }
  const startHour = Number(match[1]);
  const startMinute = Number(match[2]);
  const endHour = Number(match[3]);
  const endMinute = Number(match[4]);
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) {
    return undefined;
  }
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;
  if (startMinutes === endMinutes) {
    // Zero-length / full-day ambiguity — reject as malformed.
    return undefined;
  }
  return { weekdays, startMinutes, endMinutes, raw: trimmed };
}

export function parseTimeWindows(windows: readonly string[] | undefined): ParsedTimeWindows {
  const parsed: ParsedTimeWindow[] = [];
  const malformed: string[] = [];
  for (const entry of windows ?? []) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      if (typeof entry === 'string') {
        // blank strings are ignored, not treated as malformed
        continue;
      }
      malformed.push(String(entry));
      continue;
    }
    const window = parseWindow(entry);
    if (window) {
      parsed.push(window);
    } else {
      malformed.push(entry.trim());
    }
  }
  return { windows: parsed, malformed, hasWarning: malformed.length > 0 };
}

function matchesWindow(window: ParsedTimeWindow, date: Date): boolean {
  const iso = weekdayIso(date);
  const minutes = date.getHours() * 60 + date.getMinutes();

  if (window.startMinutes < window.endMinutes) {
    if (window.weekdays && !window.weekdays.has(iso)) {
      return false;
    }
    return minutes >= window.startMinutes && minutes < window.endMinutes;
  }

  // Overnight window: [start, 24:00) on the start day OR [00:00, end) the next day.
  const inEvening = minutes >= window.startMinutes;
  const inMorning = minutes < window.endMinutes;
  if (!inEvening && !inMorning) {
    return false;
  }
  if (!window.weekdays) {
    return true;
  }
  if (inEvening) {
    return window.weekdays.has(iso);
  }
  // The morning part belongs to a window that started on the previous day.
  return window.weekdays.has(previousWeekdayIso(iso));
}

/**
 * True when `date` falls inside any configured window. Empty/absent windows and
 * all-malformed lists are treated as always available (fail-open).
 */
export function isWithinWindows(windows: readonly string[] | undefined, date: Date = new Date()): boolean {
  const parsed = parseTimeWindows(windows);
  if (parsed.windows.length === 0) {
    return true;
  }
  return parsed.windows.some(window => matchesWindow(window, date));
}
