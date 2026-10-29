/** Public contact links explicitly supplied by the Mita Japan owner. */
export const DEFAULT_ZALO_CONTACT = 'https://zalo.me/818077391629';
export const DEFAULT_FACEBOOK_PAGE = 'https://www.facebook.com/p/Mita-Japan-100091066656305/';

/** Refuse malformed links, credentials, unusual schemes or unexpected hosts. */
export function contactHref(raw: string | undefined, service: 'zalo' | 'facebook'): string | null {
  if (!raw || !raw.startsWith('https://') || /[\\\s]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.port || url.hash) return null;
    if (service === 'zalo') {
      if (url.hostname !== 'zalo.me' || !/^\/[0-9]{8,15}\/?$/.test(url.pathname) || url.search) return null;
    } else {
      const facebook = ['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(url.hostname);
      const messenger = ['m.me', 'www.m.me'].includes(url.hostname);
      const pagePath = /^\/[A-Za-z0-9._-]+\/?$/.test(url.pathname);
      const businessPagePath = /^\/p\/[A-Za-z0-9._-]+-[0-9]{8,20}\/?$/.test(url.pathname);
      const profile = url.pathname === '/profile.php' && /^\?id=[0-9]+$/.test(url.search);
      if (!(facebook && (((pagePath || businessPagePath) && !url.search) || profile) ||
        messenger && pagePath && !url.search)) return null;
    }
    return url.href;
  } catch {
    return null;
  }
}
