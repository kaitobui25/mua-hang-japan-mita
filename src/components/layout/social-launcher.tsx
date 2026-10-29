"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/icons";

type Props = { zalo: string | null; messenger: string | null };

export function SocialLauncher({ zalo, messenger }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function close(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  if (!zalo && !messenger) return null;

  return <div className="social-launcher" ref={root}>
    {open && <div id="social-contact-options" className="social-launcher-options" aria-label="Chọn kênh nhắn tin">
      {zalo && <a href={zalo} target="_blank" rel="noopener noreferrer" className="social-launcher-choice" onClick={() => setOpen(false)}>
        <span className="social-launcher-mark">Z</span><span>Zalo</span>
      </a>}
      {messenger && <a href={messenger} target="_blank" rel="noopener noreferrer" className="social-launcher-choice" onClick={() => setOpen(false)}>
        <span className="social-launcher-mark social-launcher-mark-messenger"><Icon name="message" size={19}/></span><span>Messenger</span>
      </a>}
    </div>}
    <button type="button" className="social-launcher-toggle" aria-label={open ? "Đóng các kênh liên hệ" : "Mở các kênh liên hệ"} aria-expanded={open} aria-controls="social-contact-options" onClick={() => setOpen(prev => !prev)}>
      <Icon name={open ? "x" : "message"} size={24}/>
      <span className="visually-hidden">{open ? "Đóng" : "Liên hệ"}</span>
    </button>
  </div>;
}
