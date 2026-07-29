const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface LocalRequestValidation {
  allowed: boolean;
  statusCode?: 400 | 403;
  message?: string;
}

function parseAuthority(authority: string): URL | null {
  try {
    const url = new URL(`http://${authority}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export function validateLocalRequest(
  hostHeader: string | string[] | undefined,
  originHeader: string | string[] | undefined
): LocalRequestValidation {
  if (typeof hostHeader !== 'string') {
    return { allowed: false, statusCode: 400, message: 'Missing or invalid Host header.' };
  }

  const host = parseAuthority(hostHeader);
  if (!host || !LOOPBACK_HOSTS.has(host.hostname.toLowerCase())) {
    return { allowed: false, statusCode: 403, message: 'Only loopback Host headers are allowed.' };
  }

  if (originHeader === undefined) {
    return { allowed: true };
  }

  if (typeof originHeader !== 'string') {
    return { allowed: false, statusCode: 403, message: 'Invalid Origin header.' };
  }

  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    return { allowed: false, statusCode: 403, message: 'Invalid Origin header.' };
  }

  if (
    origin.protocol !== 'http:' ||
    !LOOPBACK_HOSTS.has(origin.hostname.toLowerCase()) ||
    origin.host.toLowerCase() !== host.host.toLowerCase()
  ) {
    return { allowed: false, statusCode: 403, message: 'Cross-origin requests are not allowed.' };
  }

  return { allowed: true };
}
