import type { AcademicPlanState, Weekday } from '../types/domain.ts';
import {
  getTimetableCellRange,
  isCellLockedByPreEnlisted,
  type BlockedCellCoordinate,
} from './scheduleView.ts';

export type DragBlockMode = 'block' | 'unblock';

export interface TimetableDragSession {
  mode: DragBlockMode;
  start: BlockedCellCoordinate;
  current: BlockedCellCoordinate;
  pointerId?: number;
}

export interface GlobalEventTargetLike {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export interface PointerDownSlotInput {
  day: Weekday;
  startMinutes: number;
  isLocked: boolean;
  isBlocked: boolean;
  pointerId?: number;
  button?: number;
}

export interface PointerEnterSlotInput {
  day: Weekday;
  startMinutes: number;
}

export interface ClickSlotInput {
  day: Weekday;
  startMinutes: number;
  isLocked: boolean;
}

export interface TimetableDragControllerOptions {
  isBlockingEnabled: boolean;
  onSessionChange: (session: TimetableDragSession | null) => void;
  onCommitRange: (cells: readonly BlockedCellCoordinate[], mode: DragBlockMode) => void;
  onToggleCell: (day: Weekday, startMinutes: number) => void;
}

/**
 * Computes the set of `"${day}:${startMinutes}"` cell keys included in the active drag rectangle,
 * excluding cells occupied by locked pre-enlisted courses.
 */
export function getDragPreviewCellKeys(
  plan: AcademicPlanState,
  session: TimetableDragSession | null
): Set<string> {
  const keys = new Set<string>();
  if (!session) {
    return keys;
  }

  for (const cell of getTimetableCellRange(session.start, session.current)) {
    if (!isCellLockedByPreEnlisted(plan, cell.day, cell.startMinutes, cell.startMinutes + 60)) {
      keys.add(`${cell.day}:${cell.startMinutes}`);
    }
  }
  return keys;
}

/**
 * Coordinates click-and-drag timetable blocking/unblocking, global pointerup/cancel cleanup,
 * tab gating, and single-click deduplication so a pointer tap never double-fires on `click`.
 */
export class TimetableDragController {
  private isBlockingEnabled: boolean;
  private onSessionChange: (session: TimetableDragSession | null) => void;
  private onCommitRange: (cells: readonly BlockedCellCoordinate[], mode: DragBlockMode) => void;
  private onToggleCell: (day: Weekday, startMinutes: number) => void;
  private session: TimetableDragSession | null = null;
  private suppressNextClick = false;
  private suppressTimerId: ReturnType<typeof setTimeout> | null = null;

  constructor(options: TimetableDragControllerOptions) {
    this.isBlockingEnabled = options.isBlockingEnabled;
    this.onSessionChange = options.onSessionChange;
    this.onCommitRange = options.onCommitRange;
    this.onToggleCell = options.onToggleCell;
  }

  updateOptions(options: TimetableDragControllerOptions): void {
    this.isBlockingEnabled = options.isBlockingEnabled;
    this.onSessionChange = options.onSessionChange;
    this.onCommitRange = options.onCommitRange;
    this.onToggleCell = options.onToggleCell;

    if (!this.isBlockingEnabled && this.session) {
      this.cancelDrag();
    }
  }

  getSession(): TimetableDragSession | null {
    return this.session;
  }

  handlePointerDown(input: PointerDownSlotInput): boolean {
    if (!this.isBlockingEnabled || input.isLocked) {
      return false;
    }
    if (input.button !== undefined && input.button !== 0) {
      return false;
    }
    if (this.session !== null) {
      return false;
    }

    this.clearSuppressTimer();
    this.suppressNextClick = false;

    const mode: DragBlockMode = input.isBlocked ? 'unblock' : 'block';
    const nextSession: TimetableDragSession = {
      mode,
      start: { day: input.day, startMinutes: input.startMinutes },
      current: { day: input.day, startMinutes: input.startMinutes },
      pointerId: input.pointerId,
    };

    this.session = nextSession;
    this.onSessionChange(nextSession);
    return true;
  }

  handlePointerEnter(input: PointerEnterSlotInput): boolean {
    if (!this.isBlockingEnabled || !this.session) {
      return false;
    }
    if (
      this.session.current.day === input.day &&
      this.session.current.startMinutes === input.startMinutes
    ) {
      return false;
    }

    const nextSession: TimetableDragSession = {
      ...this.session,
      current: { day: input.day, startMinutes: input.startMinutes },
    };
    this.session = nextSession;
    this.onSessionChange(nextSession);
    return true;
  }

  finalizeDrag(pointerId?: number): boolean {
    const active = this.session;
    if (!active) {
      return false;
    }
    if (
      typeof pointerId === 'number' &&
      typeof active.pointerId === 'number' &&
      pointerId !== active.pointerId
    ) {
      return false;
    }

    this.session = null;
    this.onSessionChange(null);

    // Suppress the browser's trailing synthetic `click` on pointer release so single clicks do not double-toggle.
    this.clearSuppressTimer();
    this.suppressNextClick = true;
    this.suppressTimerId = setTimeout(() => {
      this.suppressNextClick = false;
      this.suppressTimerId = null;
    }, 0);

    if (!this.isBlockingEnabled) {
      return false;
    }

    const range = getTimetableCellRange(active.start, active.current);
    this.onCommitRange(range, active.mode);
    return true;
  }

  cancelDrag(): void {
    this.clearSuppressTimer();
    this.suppressNextClick = false;
    if (!this.session) {
      return;
    }
    this.session = null;
    this.onSessionChange(null);
  }

  handleClick(input: ClickSlotInput): boolean {
    if (this.suppressNextClick) {
      this.clearSuppressTimer();
      this.suppressNextClick = false;
      return false;
    }
    if (!this.isBlockingEnabled || input.isLocked) {
      return false;
    }
    this.onToggleCell(input.day, input.startMinutes);
    return true;
  }

  attachGlobalListeners(targets: readonly GlobalEventTargetLike[]): () => void {
    const onPointerUp: EventListener = (event) => {
      const pointerId = (event as { pointerId?: number }).pointerId;
      this.finalizeDrag(pointerId);
    };
    const onCancel: EventListener = () => {
      this.cancelDrag();
    };

    for (const target of targets) {
      target.addEventListener('pointerup', onPointerUp);
      target.addEventListener('pointercancel', onCancel);
      target.addEventListener('blur', onCancel);
    }

    return () => {
      this.clearSuppressTimer();
      for (const target of targets) {
        target.removeEventListener('pointerup', onPointerUp);
        target.removeEventListener('pointercancel', onCancel);
        target.removeEventListener('blur', onCancel);
      }
    };
  }

  private clearSuppressTimer(): void {
    if (this.suppressTimerId !== null) {
      clearTimeout(this.suppressTimerId);
      this.suppressTimerId = null;
    }
  }
}
