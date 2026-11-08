// What the app's window is allowed to do. The page is local and trusted, but the app must never become a way to
// load anything else (docs/security.md).

/** Does `url` belong to the app: the exact origin of its own server? */
export function isAppUrl(url: string, port: number): boolean {
  try {
    return new URL(url).origin === `http://127.0.0.1:${port}`;
  } catch {
    return false;
  }
}

/** A link that may open in the user's browser: http(s), no embedded credentials. Returns it normalized, or null. */
export function externalUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** Only notifications are granted; camera, microphone, location, clipboard-read, … are all refused. */
export function permissionAllowed(permission: string): boolean {
  return permission === 'notifications';
}

/** The Content-Security-Policy the server already sends is kept; this checks the page we load is served by it. */
export function isTrustedSender(senderUrl: string | undefined, port: number): boolean {
  return !!senderUrl && isAppUrl(senderUrl, port);
}
