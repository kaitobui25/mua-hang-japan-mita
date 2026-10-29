"use client";

/** Meta retired its website chat embed. Open the actual Messenger conversation
 * in a separate compact browser window, keeping the storefront intact. */
export function FacebookChatPopup({ href }: { href: string }) {
  return <a href={href} target="_blank" rel="noopener noreferrer"
    aria-label="Nhắn tin Facebook qua Messenger (mở cửa sổ riêng)" onClick={event => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const width = Math.min(440, window.screen.availWidth);
    const height = Math.min(720, window.screen.availHeight);
    const left = Math.max(0, Math.round((window.screen.availWidth - width) / 2));
    const top = Math.max(0, Math.round((window.screen.availHeight - height) / 2));
    let popup: Window | null = null;
    try {
      popup = window.open(href, 'mita-messenger-chat',
        `popup=yes,width=${width},height=${height},left=${left},top=${top}`);
    } catch { /* The native link below remains the fallback. */ }
    if (popup) {
      event.preventDefault();
      try { popup.opener = null; popup.focus(); } catch { /* Meta controls its own window. */ }
    }
    // If the browser blocks popups, the anchor opens Messenger in a new tab.
  }}>Nhắn tin Facebook</a>;
}
