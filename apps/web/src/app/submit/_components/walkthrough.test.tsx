import * as React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WALKTHROUGH_SEEN_KEY, WALKTHROUGH_SLIDES } from '@ohj/shared/client';
import { LearnerGuidanceProvider, useLearnerGuidance } from './walkthrough';

/**
 * The tour, driven rather than read.
 *
 * "Shows once" is a claim about state that survives a reload, and the only
 * honest way to check it is to mount the thing twice and see what it does the
 * second time. A source-inspection test would happily pass on a component that
 * reads the flag and ignores it.
 */

const COHORT = 'cohort-synthetic-1';
const GROUP = 42;

/** A stand-in for the portal: shows which step is current, and can replay the tour. */
function Harness() {
  const { step, goToStep, openTour, tourOpen } = useLearnerGuidance();
  return (
    <div>
      <p data-testid="current-step">{step}</p>
      <p data-testid="tour-open">{String(tourOpen)}</p>
      <button type="button" onClick={() => goToStep('learning')}>
        Go to learning
      </button>
      <button type="button" onClick={openTour}>
        Replay submission tour
      </button>
    </div>
  );
}

function mount() {
  return render(
    <LearnerGuidanceProvider cohortId={COHORT} groupNumber={GROUP}>
      <Harness />
    </LearnerGuidanceProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('the first visit', () => {
  it('shows the tour', async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId('submission-walkthrough')).toBeTruthy());
    expect(screen.getByRole('heading', { name: 'Submit your hackathon project' })).toBeTruthy();
  });

  it('opens on the welcome card, with Back unavailable', async () => {
    mount();
    await waitFor(() => screen.getByTestId('submission-walkthrough'));
    expect(screen.getByText('Welcome')).toBeTruthy();
    expect(screen.getByTestId('tour-back')).toHaveProperty('disabled', true);
  });

  it('walks forward through all seven cards and ends with Start my submission', async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => screen.getByTestId('submission-walkthrough'));

    for (let i = 0; i < WALKTHROUGH_SLIDES.length - 1; i += 1) {
      expect(screen.getByRole('heading', { name: WALKTHROUGH_SLIDES[i]!.title })).toBeTruthy();
      await user.click(screen.getByTestId('tour-next'));
    }

    const last = WALKTHROUGH_SLIDES[WALKTHROUGH_SLIDES.length - 1]!;
    expect(screen.getByRole('heading', { name: last.title })).toBeTruthy();
    expect(screen.getByTestId('tour-start')).toBeTruthy();
    expect(screen.queryByTestId('tour-next')).toBeNull();
  });

  it('goes back as well as forward', async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => screen.getByTestId('submission-walkthrough'));

    await user.click(screen.getByTestId('tour-next'));
    expect(screen.getByRole('heading', { name: 'Team' })).toBeTruthy();
    await user.click(screen.getByTestId('tour-back'));
    expect(screen.getByRole('heading', { name: 'Submit your hackathon project' })).toBeTruthy();
  });
});

describe('leaving the tour', () => {
  it('closes on Skip tour', async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => screen.getByTestId('submission-walkthrough'));

    await user.click(screen.getByTestId('skip-tour'));
    expect(screen.queryByTestId('submission-walkthrough')).toBeNull();
  });

  it('closes on Start my submission', async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => screen.getByTestId('submission-walkthrough'));

    for (let i = 0; i < WALKTHROUGH_SLIDES.length - 1; i += 1) {
      await user.click(screen.getByTestId('tour-next'));
    }
    await user.click(screen.getByTestId('tour-start'));
    expect(screen.queryByTestId('submission-walkthrough')).toBeNull();
  });

  it('does not come back on the next visit', async () => {
    const user = userEvent.setup();
    const first = mount();
    await waitFor(() => screen.getByTestId('submission-walkthrough'));
    await user.click(screen.getByTestId('skip-tour'));
    first.unmount();

    mount();
    // Give the mount effect every chance to decide it should appear.
    await waitFor(() => expect(screen.getByTestId('tour-open').textContent).toBe('false'));
    expect(screen.queryByTestId('submission-walkthrough')).toBeNull();
  });

  it('remembers per team, so a shared laptop still shows it to the next one', async () => {
    const user = userEvent.setup();
    const first = mount();
    await waitFor(() => screen.getByTestId('submission-walkthrough'));
    await user.click(screen.getByTestId('skip-tour'));
    first.unmount();

    render(
      <LearnerGuidanceProvider cohortId={COHORT} groupNumber={GROUP + 1}>
        <Harness />
      </LearnerGuidanceProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('submission-walkthrough')).toBeTruthy());
  });
});

describe('replaying it', () => {
  it('opens again on request, from the beginning', async () => {
    const user = userEvent.setup();
    const first = mount();
    await waitFor(() => screen.getByTestId('submission-walkthrough'));
    await user.click(screen.getByTestId('tour-next'));
    await user.click(screen.getByTestId('skip-tour'));
    first.unmount();

    mount();
    await waitFor(() => expect(screen.getByTestId('tour-open').textContent).toBe('false'));

    await user.click(screen.getByRole('button', { name: 'Replay submission tour' }));
    expect(screen.getByTestId('submission-walkthrough')).toBeTruthy();
    // From the welcome card, not from wherever it was abandoned.
    expect(screen.getByRole('heading', { name: 'Submit your hackathon project' })).toBeTruthy();
  });
});

describe('what it stores', () => {
  it('writes one flag, under its own key, and nothing else', async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => screen.getByTestId('submission-walkthrough'));
    await user.click(screen.getByTestId('skip-tour'));

    const keys = Object.keys(window.localStorage);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe(`${WALKTHROUGH_SEEN_KEY}:${COHORT}:${GROUP}`);

    // A timestamp. Not a draft, not an answer, not a version.
    const stored = window.localStorage.getItem(keys[0]!)!;
    expect(new Date(stored).toString()).not.toBe('Invalid Date');
  });

  it('survives storage being unavailable', async () => {
    // Private browsing throws on both read and write. The tour is worth less
    // than the form behind it, so it must fail quietly rather than take the
    // page down.
    const storage = window.localStorage;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled');
      },
    });

    try {
      expect(() => mount()).not.toThrow();
      await waitFor(() => expect(screen.getByTestId('tour-open').textContent).toBe('false'));
    } finally {
      Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
    }
  });
});

describe('the step it is wrapped around', () => {
  it('starts on Team and follows navigation', async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => screen.getByTestId('submission-walkthrough'));
    await user.click(screen.getByTestId('skip-tour'));

    expect(screen.getByTestId('current-step').textContent).toBe('team');
    await user.click(screen.getByRole('button', { name: 'Go to learning' }));
    expect(screen.getByTestId('current-step').textContent).toBe('learning');
  });
});
