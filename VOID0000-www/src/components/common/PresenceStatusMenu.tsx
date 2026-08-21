import { Check, LoaderCircle } from 'lucide-react';
import {
  PRESENCE_MODE_OPTIONS,
  type PresenceMode,
  type PresenceStatus,
} from '../../Services/Presence/presenceStatus';
import PresenceDot from './PresenceDot';

interface PresenceStatusMenuProps {
  mode: PresenceMode;
  ownStatus: PresenceStatus;
  busy: boolean;
  error: string | null;
  onSelect: (mode: PresenceMode) => void;
}

export default function PresenceStatusMenu({
  mode,
  ownStatus,
  busy,
  error,
  onSelect,
}: PresenceStatusMenuProps) {
  return (
    <div
      role="menu"
      aria-label="Choose active status"
      className="rounded-xl border border-void-bg-hover bg-void-bg-secondary p-1.5 shadow-2xl"
    >
      <div className="px-2.5 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-void-text-muted">
        Active status
      </div>

      {PRESENCE_MODE_OPTIONS.map((option) => {
        const selected = option.mode === mode;
        const status = option.publicStatus ?? (mode === 'online' ? ownStatus : 'online');

        return (
          <button
            key={option.mode}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            disabled={busy}
            onClick={() => onSelect(option.mode)}
            className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors disabled:cursor-wait disabled:opacity-60 ${
              selected
                ? 'bg-void-accent/12 text-void-text'
                : 'text-void-text hover:bg-void-bg-hover'
            }`}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center">
              <PresenceDot status={status} size="md" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{option.label}</span>
              <span className="block text-[11px] leading-4 text-void-text-muted">
                {option.description}
              </span>
            </span>
            {selected ? <Check className="h-4 w-4 shrink-0 text-void-accent" /> : null}
          </button>
        );
      })}

      {busy ? (
        <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-void-text-muted">
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          Saving status...
        </div>
      ) : null}

      {error ? (
        <p className="px-2.5 py-1.5 text-xs text-red-400" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
