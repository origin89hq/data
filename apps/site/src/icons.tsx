const paths = {
  refresh: "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  arrowUpRight: "M6 18 18 6M6 6h12v12",
  arrowRight: "M4 12h16m-6-6 6 6-6 6",
  arrowLeft: "M20 12H4m6-6-6 6 6 6",
  equipment: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  specifications: "M4 7h9m4 0h3M4 17h3m4 0h9M13 4v6h4V4zM7 14v6h4v-6z",
  protocols: "M6 3v5m12-5v5M3 8h6v5H3zM15 8h6v5h-6zM6 13v3a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4v-3",
  evidence: "M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 14l3 3 5-6",
  download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
  copy: "M8 8h12v13H8zM16 8V3H3v13h5",
  search: "M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15ZM16 16l5 5",
  close: "m6 6 12 12M6 18 18 6",
} as const;

export function Icon({ name, className = "" }: { name: keyof typeof paths; className?: string }) {
  return (
    <svg
      className={`ui-icon ${className}`}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}
