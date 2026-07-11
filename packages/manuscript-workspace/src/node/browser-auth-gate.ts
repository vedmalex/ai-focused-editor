// *****************************************************************************
// Pure, dependency-free gate helpers (loopback detection + cookie parsing +
// the enable/allow decision). Kept side-effect free so they can be unit tested
// without an HTTP server.
// *****************************************************************************

/**
 * Is a remote address a loopback (localhost) peer? Handles bare IPv4
 * (`127.0.0.0/8`), IPv6 loopback (`::1`), and IPv4-mapped IPv6
 * (`::ffff:127.0.0.1`). An undefined address (unusual) is treated as NON-loopback
 * so it fails safe toward gating.
 */
export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) {
    return false;
  }
  let addr = remoteAddress.trim().toLowerCase();
  // Strip a zone id (e.g. `fe80::1%en0`) — irrelevant for the loopback check.
  const pct = addr.indexOf('%');
  if (pct >= 0) {
    addr = addr.slice(0, pct);
  }
  if (addr === '::1') {
    return true;
  }
  // IPv4-mapped IPv6.
  if (addr.startsWith('::ffff:')) {
    addr = addr.slice('::ffff:'.length);
  }
  return addr === 'localhost' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
}

/** Parse an HTTP `Cookie` header into a name→value map. Tolerant of malformed pairs. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) {
    return out;
  }
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) {
      continue;
    }
    const name = part.slice(0, eq).trim();
    if (!name) {
      continue;
    }
    let value = part.slice(eq + 1).trim();
    // Strip optional surrounding quotes.
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Should a connection from `remoteAddress` be gated (i.e. require a valid
 * session)? Encodes the localhost-frictionless rule:
 *
 *  - the gate must be `enabled` at all (a credential is configured), AND
 *  - either the peer is NOT loopback, OR gating is `forceEnabled` (`--auth`).
 *
 * When the gate is disabled the answer is always `false` (pass-through).
 */
export function shouldGateConnection(params: {
  enabled: boolean;
  forceEnabled: boolean;
  remoteAddress: string | undefined;
}): boolean {
  if (!params.enabled) {
    return false;
  }
  if (params.forceEnabled) {
    return true;
  }
  return !isLoopbackAddress(params.remoteAddress);
}
