interface LeftFooterStripProps {
  hardClashCount: number;
  isSolving: boolean;
  onOpenPreferences: () => void;
}

export function LeftFooterStrip({
  hardClashCount,
  isSolving,
  onOpenPreferences,
}: LeftFooterStripProps) {
  const clashLabel =
    hardClashCount === 0
      ? '0 Hard Clashes'
      : hardClashCount === 1
        ? '1 Hard Clash'
        : `${hardClashCount} Hard Clashes`;

  return (
    <div className="left-footer-strip">
      <div className="conflict-check-status">
        <span>Schedule Conflict Check: </span>
        {isSolving ? (
          <strong className="conflict-check-status--solving">Running CP-SAT...</strong>
        ) : (
          <strong
            className={
              hardClashCount === 0
                ? 'conflict-check-status--ok'
                : 'conflict-check-status--error'
            }
          >
            {clashLabel}
          </strong>
        )}
      </div>

      <button
        type="button"
        className="btn-maroon-sm"
        onClick={onOpenPreferences}
      >
        Preferences &amp; Weights
      </button>
    </div>
  );
}
