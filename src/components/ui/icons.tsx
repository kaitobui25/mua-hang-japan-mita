import type { SVGProps } from "react";

type IconName = "search" | "bag" | "arrow" | "arrow-left" | "menu" | "x" | "plus" | "minus" | "filter" | "leaf" | "check" | "clock" | "truck" | "shield" | "heart" | "home" | "grid" | "chevron" | "message";

export function Icon({ name, size = 20, ...props }: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    search: <><circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/></>,
    bag: <><rect x="4" y="7" width="16" height="14" rx="2"/><path d="M8 9V6a4 4 0 0 1 8 0v3"/></>,
    arrow: <><path d="M3 12h17m-7-7 7 7-7 7"/></>,
    "arrow-left": <><path d="M21 12H4m7 7-7-7 7-7"/></>,
    menu: <><path d="M4 7h16M4 12h16M4 17h16"/></>,
    x: <><path d="M5 5 19 19M19 5 5 19"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    minus: <path d="M5 12h14"/>,
    filter: <><path d="M4 7h16M7 12h10m-7 5h4"/><circle cx="9" cy="7" r="2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none"/></>,
    leaf: <><path d="M20 4c-9 0-15 3-15 11a5 5 0 0 0 5 5c8 0 10-7 10-16Z"/><path d="M5 20c4-7 7-10 12-13"/></>,
    check: <path d="m4 12 5 5L20 6"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    truck: <><path d="M3 6h12v12H3zM15 10h3l3 3v5h-6"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></>,
    shield: <><path d="M12 2 4 6v6c0 5 3 8 8 10 5-2 8-5 8-10V6Z"/><path d="m9 12 2 2 4-4"/></>,
    heart: <path d="M20 9c0 5-8 10-8 10S4 14 4 9a4 4 0 0 1 8-1 4 4 0 0 1 8 1Z"/>,
    home: <><path d="m3 11 9-8 9 8v10H3Z"/><path d="M9 21v-7h6v7"/></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    chevron: <path d="m7 10 5 5 5-5"/>,
    message: <><path d="M20 11.5a8 8 0 0 1-8 8c-1.4 0-2.7-.3-3.9-.9L4 20l1.5-4a8 8 0 1 1 14.5-4.5Z"/><path d="M8 12h8M8 9h5"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>{paths[name]}</svg>;
}
