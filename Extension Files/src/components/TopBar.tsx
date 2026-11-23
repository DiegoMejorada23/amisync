import { CloseIcon } from './Icons.tsx';

interface TopBarProps {
  canExpandOverlay: boolean;
  onExpandOverlay: () => void;
  onDismiss: () => void;
}

export function TopBar({
  canExpandOverlay,
  onExpandOverlay,
  onDismiss,
}: TopBarProps) {
  return (
    <header className="top-bar">
      <h1 className="top-bar__title">SCHEDULE OPTIMIZER</h1>
      <div className="top-bar__actions">
        {canExpandOverlay && (
          <button
            type="button"
            className="top-bar__expand"
            title="Open full modal overlay on AMIS page"
            onClick={onExpandOverlay}
          >
            Open Overlay
          </button>
        )}
        <button
          type="button"
          className="top-bar__close"
          aria-label="Close Schedule Optimizer"
          onClick={onDismiss}
        >
          <CloseIcon width={14} height={14} />
        </button>
      </div>
    </header>
  );
}
