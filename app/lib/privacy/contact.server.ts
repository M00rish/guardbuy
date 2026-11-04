// A configured public support destination only; never infer it from merchant sessions or credentials.
export function privacyContact(raw = process.env.GUARDBUY_PRIVACY_CONTACT): string | null {
  if (!raw || raw.length > 300 || /[\r\n]|%0[ad]/i.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" && url.hostname && !url.username && !url.password) return url.href;
    if (url.protocol === "mailto:" && /^[^\s@<>?]+@[^\s@<>?]+\.[^\s@<>?]+$/.test(url.pathname) && !url.search && !url.hash) return url.href;
  } catch { /* Never render unsafe or malformed links. */ }
  return null;
}
