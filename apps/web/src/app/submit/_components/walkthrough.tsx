'use client';

import * as React from 'react';
import {
  WALKTHROUGH_SEEN_KEY,
  WALKTHROUGH_SLIDES,
  type LearnerStepKey,
} from '@ohj/shared/client';
import { Button, cn } from '@/components/ui';

/**
 * The two-minute tour, shown once.
 *
 * A team arrives at this form having been told about it in a session they may
 * have half-watched, on a day they have spent building something else. Seven
 * cards, one sentence each: what the six steps are, that work saves as it goes,
 * and that Final Submit is the one door that only opens outwards.
 *
 * Shown on the first entry and then not again. It can be replayed from the help
 * menu — deliberately, because the person who needs it most is the one who
 * skipped it at 9am and is back at 11pm.
 *
 * It writes one flag to `localStorage` and touches nothing else. Whether
 * somebody has seen a tour is a fact about a browser, not about a submission;
 * putting it in the draft payload would mean a guidance feature bumping the
 * submission version and racing a teammate's save over something that is not
 * part of anyone's entry.
 */

interface GuidanceContextValue {
  /** Replay the tour from the beginning. */
  openTour: () => void;
  tourOpen: boolean;
  /**
   * Which step is on screen.
   *
   * Owned here rather than by the form, because the help menu sits outside the
   * form and "How to fill this step" has to know which step that is. One owner
   * beats two copies that agree until they don't.
   */
  step: LearnerStepKey;
  goToStep: (step: LearnerStepKey) => void;
}

const GuidanceContext = React.createContext<GuidanceContextValue | null>(null);

export function useLearnerGuidance(): GuidanceContextValue {
  const context = React.useContext(GuidanceContext);
  if (!context) {
    throw new Error('useLearnerGuidance must be used inside LearnerGuidanceProvider');
  }
  return context;
}

/**
 * Per team, per cohort.
 *
 * Two teams sharing a laptop is ordinary at a hackathon, and the second one
 * should still get the tour.
 */
function seenKey(cohortId: string, groupNumber: number): string {
  return `${WALKTHROUGH_SEEN_KEY}:${cohortId}:${groupNumber}`;
}

export function LearnerGuidanceProvider({
  cohortId,
  groupNumber,
  children,
}: {
  cohortId: string;
  groupNumber: number;
  children: React.ReactNode;
}) {
  const [tourOpen, setTourOpen] = React.useState(false);
  const [step, setStep] = React.useState<LearnerStepKey>('team');

  /**
   * Decided after mount, never during render.
   *
   * `localStorage` does not exist on the server, so a first render that
   * consulted it would produce different HTML on each side and React would
   * discard the tree. The tour appearing a beat after the page is the correct
   * trade — the page is readable underneath it either way.
   */
  React.useEffect(() => {
    try {
      if (window.localStorage.getItem(seenKey(cohortId, groupNumber)) === null) {
        setTourOpen(true);
      }
    } catch {
      // Private browsing, or storage disabled. Skipping the tour is a better
      // failure than showing it on every single page load.
    }
  }, [cohortId, groupNumber]);

  const markSeen = React.useCallback(() => {
    try {
      window.localStorage.setItem(seenKey(cohortId, groupNumber), new Date().toISOString());
    } catch {
      // Nothing to do. Worst case it is offered again next visit.
    }
  }, [cohortId, groupNumber]);

  const close = React.useCallback(() => {
    markSeen();
    setTourOpen(false);
  }, [markSeen]);

  const goToStep = React.useCallback((next: LearnerStepKey) => {
    setStep(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const value = React.useMemo<GuidanceContextValue>(
    () => ({ tourOpen, openTour: () => setTourOpen(true), step, goToStep }),
    [tourOpen, step, goToStep],
  );

  return (
    <GuidanceContext.Provider value={value}>
      {children}
      {tourOpen && <Walkthrough onClose={close} />}
    </GuidanceContext.Provider>
  );
}

// --------------------------------------------------------------------------

/**
 * A bottom sheet on a phone, a centred card on a laptop.
 *
 * Never a full-screen modal: the form behind it is the thing being explained,
 * and covering it entirely makes the tour feel like a wall to get past rather
 * than an introduction to what is underneath.
 */
export function Walkthrough({ onClose }: { onClose: () => void }) {
  const [index, setIndex] = React.useState(0);
  const panelRef = React.useRef<HTMLDivElement>(null);

  const slide = WALKTHROUGH_SLIDES[index]!;
  const isFirst = index === 0;
  const isLast = index === WALKTHROUGH_SLIDES.length - 1;

  React.useEffect(() => {
    panelRef.current?.focus();
  }, []);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  /**
   * The page behind must not scroll while the sheet is open.
   *
   * On iOS a touch drag over a fixed overlay scrolls whatever is underneath,
   * which reads as the tour sliding off the top of the screen.
   */
  React.useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="walkthrough-title"
      data-testid="submission-walkthrough"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          'w-full max-w-md bg-surface shadow-xl outline-none',
          'rounded-t-[18px] sm:rounded-[18px]',
          'border-t border-line sm:border',
        )}
      >
        <div className="px-5 pb-4 pt-5 sm:px-7 sm:pt-7">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-brand-text">
              {isFirst ? 'Welcome' : `Step ${index} of ${WALKTHROUGH_SLIDES.length - 1}`}
            </p>
            <button
              type="button"
              onClick={onClose}
              data-testid="skip-tour"
              className="min-h-11 px-1 text-sm font-semibold text-muted underline underline-offset-4 hover:text-ink"
            >
              Skip tour
            </button>
          </div>

          <h2 id="walkthrough-title" className="mt-3 text-2xl font-bold text-ink">
            {slide.title}
          </h2>
          <p className="mt-2.5 text-base text-muted">{slide.body}</p>
        </div>

        {/* Position, shown as dots. Seven cards is short enough that a bar
            would overstate how long this takes. */}
        <div className="flex justify-center gap-1.5 px-5 pb-4 sm:px-7">
          {WALKTHROUGH_SLIDES.map((item, dotIndex) => (
            <span
              key={item.key}
              aria-hidden="true"
              className={cn(
                'h-1.5 rounded-full transition-all',
                dotIndex === index ? 'w-5 bg-brand' : 'w-1.5 bg-line',
              )}
            />
          ))}
        </div>
        <p className="sr-only" aria-live="polite">
          {`Card ${index + 1} of ${WALKTHROUGH_SLIDES.length}: ${slide.title}`}
        </p>

        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-4 sm:px-7">
          <Button
            variant="ghost"
            onClick={() => setIndex((current) => Math.max(0, current - 1))}
            disabled={isFirst}
            data-testid="tour-back"
          >
            Back
          </Button>

          {isLast ? (
            <Button onClick={onClose} data-testid="tour-start">
              Start my submission
            </Button>
          ) : (
            <Button
              onClick={() => setIndex((current) => Math.min(WALKTHROUGH_SLIDES.length - 1, current + 1))}
              data-testid="tour-next"
            >
              Next
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
