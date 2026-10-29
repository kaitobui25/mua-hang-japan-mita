"use client";

/** Open the official Page conversation link in Messenger without forcing a small popup. */
export function FacebookChatPopup({ href }: { href: string }) {
  return <a href={href} target="_blank" rel="noopener noreferrer"
    aria-label="Nhắn tin trực tiếp với Mita Japan trên Messenger">Nhắn tin Facebook</a>;
}
