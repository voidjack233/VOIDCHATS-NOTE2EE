import { AlertTriangle, X } from 'lucide-react';

interface ChatStatusBannersProps {
  notice?: string | null;
  onDismissNotice?: () => void;
}

export default function ChatStatusBanners({
  notice,
  onDismissNotice,
}: ChatStatusBannersProps) {
  if (!notice) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[100] flex justify-center px-4">
      <div
        role="alert"
        className="pointer-events-auto flex w-full max-w-xl items-start gap-3 rounded-xl border border-amber-300/20 bg-neutral-950/95 px-4 py-3 text-sm text-amber-50 shadow-2xl shadow-black/40 supports-[backdrop-filter]:backdrop-blur-xl"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
        <span className="min-w-0 flex-1">
          {notice}
        </span>
        <button
          type="button"
          onClick={onDismissNotice}
          aria-label="Dismiss notice"
          className="-mr-1 -mt-1 rounded-md p-1 text-amber-100/60 transition-colors hover:bg-white/10 hover:text-amber-50"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
