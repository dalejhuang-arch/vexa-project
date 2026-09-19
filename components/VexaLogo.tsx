export function VexaLogo({ compact = false }: { compact?: boolean }) {
  return <div className="flex items-center gap-3" aria-label="Vexa home"><svg width={compact ? 24 : 30} height={compact ? 24 : 30} viewBox="0 0 30 30" aria-hidden="true" className="text-[var(--foreground)]"><path fill="currentColor" d="M4 3h22a1 1 0 0 1 1 1v22a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm4 5v14h4.4l2.6-3.6L17.6 22H22L15 12.6 21.8 8H16l-2.9 4L10 8H8Z" /></svg>{!compact && <span className="font-display text-2xl font-bold tracking-[-0.06em]">Vexa</span>}</div>;
}
