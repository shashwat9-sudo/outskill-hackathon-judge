import * as React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateCompleteness } from '@ohj/shared/client';
import { Input } from '@/components/ui';
import { GuidedField, MissingPanel } from './guidance';

/**
 * The guidance a learner sees while typing.
 *
 * The claim under test is narrow and important: looking at an example does not
 * put anything in the box. It is checked by driving the real component with a
 * real click and reading the real input value — the only way to catch a helpful
 * future change that decides an example may as well be a starting point.
 */

afterEach(() => {
  cleanup();
});

/** A controlled field, so the test can see whether anything wrote to it. */
function Harness({ path = 'product.exactProblem' }: { path?: string }) {
  const [value, setValue] = React.useState('');
  return (
    <>
      <GuidedField path={path} required>
        {(aria) => <Input {...aria} value={value} onChange={(e) => setValue(e.target.value)} />}
      </GuidedField>
      <p data-testid="value">{value}</p>
    </>
  );
}

describe('a question explains itself before anyone types', () => {
  it('asks the plain-English question, not the field name', () => {
    render(<Harness />);
    expect(screen.getByLabelText(/What exact problem are you solving for them\?/)).toBeTruthy();
    expect(screen.queryByText(/Exact problem/)).toBeNull();
  });

  it('shows the helper and the rule without being asked', () => {
    render(<Harness />);
    expect(screen.getByText('Describe one clear problem your user faces.')).toBeTruthy();
    expect(screen.getByText('Write at least 30 characters — usually 1–2 sentences.')).toBeTruthy();
  });

  it('ties the helper and the rule to the control for a screen reader', () => {
    render(<Harness />);
    const input = screen.getByLabelText(/What exact problem/);
    const describedBy = input.getAttribute('aria-describedby') ?? '';
    expect(describedBy).toContain('exactProblem-hint');
    expect(describedBy).toContain('exactProblem-rule');
  });

  it('gives the control the id derived from its path, so a jump can find it', () => {
    render(<Harness path="learning.bugsFixed.1.howFixed" />);
    expect(screen.getByLabelText(/How did you fix it\?/).id).toBe('bugsFixed-1-howFixed');
  });
});

describe('See example', () => {
  it('is offered on a question that is open to misreading', () => {
    render(<Harness />);
    expect(screen.getByTestId('see-example-exactProblem')).toBeTruthy();
  });

  it('is not offered on a question that speaks for itself', () => {
    render(<Harness path="team.leadName" />);
    expect(screen.queryByTestId('see-example-leadName')).toBeNull();
  });

  it('is closed until asked for', () => {
    render(<Harness />);
    expect(screen.queryByTestId('example-exactProblem')).toBeNull();
    expect(screen.getByTestId('see-example-exactProblem').getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('shows the worked answer, and says whose project it is about', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByTestId('see-example-exactProblem'));
    const example = screen.getByTestId('example-exactProblem');
    expect(example.textContent).toContain(
      'People set fitness goals but often lose track of their daily progress.',
    );
    expect(example.textContent).toContain('Write your answer about your own');
  });

  it('adds what a good answer contains, where that helps', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId('see-example-exactProblem'));
    expect(screen.getByTestId('example-exactProblem').textContent).toContain(
      'who has the problem, and what is difficult for them',
    );
  });

  it('closes again', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId('see-example-exactProblem'));
    await user.click(screen.getByTestId('see-example-exactProblem'));
    expect(screen.queryByTestId('example-exactProblem')).toBeNull();
  });
});

describe('an example is never an answer', () => {
  it('leaves an empty field empty', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByTestId('see-example-exactProblem'));

    expect(screen.getByTestId('value').textContent).toBe('');
    expect((screen.getByLabelText(/What exact problem/) as HTMLInputElement).value).toBe('');
  });

  it('leaves a written answer exactly as the learner wrote it', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const input = screen.getByLabelText(/What exact problem/) as HTMLInputElement;
    await user.type(input, 'Our own words');
    await user.click(screen.getByTestId('see-example-exactProblem'));
    await user.click(screen.getByTestId('see-example-exactProblem'));

    expect(input.value).toBe('Our own words');
    expect(screen.getByTestId('value').textContent).toBe('Our own words');
  });

  it('offers no way to copy it in', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId('see-example-exactProblem'));

    const panel = screen.getByTestId('example-exactProblem');
    expect(panel.querySelector('button')).toBeNull();
    for (const label of ['Copy', 'Use this', 'Fill', 'Insert', 'Apply']) {
      expect(screen.queryByRole('button', { name: new RegExp(label, 'i') })).toBeNull();
    }
  });
});

// --------------------------------------------------------------------------

const PART_FILLED = {
  team: { members: [{}] },
  product: {
    ideaId: 'idea-1',
    productName: 'Tracker',
    primaryUser: 'People who want a simple way to track their fitness goals.',
    exactProblem: 'People set fitness goals but often lose track of their daily progress.',
    oneSentencePromise: 'For people with goals, we built a tracker.',
    briefDescription:
      'Users create a fitness goal, add progress as they go, and see how close they are to finishing it.',
    mustHaveWorkflow: 'Create a goal, add progress, check how far along they are, and finish it.',
    excludedFeatures: 'We skipped reminders so tracking worked properly.',
    // Two left: whyAiNecessary and differentiation.
  },
  live: { coreTestSteps: [{}, {}] },
  artifacts: {},
  learning: { bugsFixed: [{}, {}, {}] },
  declarations: {},
};

describe("What's missing?", () => {
  const renderPanel = (onJump = vi.fn()) => {
    render(
      <MissingPanel
        step="product"
        completeness={evaluateCompleteness(PART_FILLED)}
        onJump={onJump}
      />,
    );
    return onJump;
  };

  it('counts what is actually left', () => {
    renderPanel();
    expect(screen.getByTestId('missing-count-product').textContent).toBe('2 things left');
  });

  it('starts collapsed, so it does not interrupt someone typing', () => {
    renderPanel();
    expect(screen.queryByTestId('missing-item-whyAiNecessary')).toBeNull();
  });

  it('lists the things themselves, in plain English', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /What’s missing\?/ }));

    expect(screen.getByTestId('missing-item-whyAiNecessary').textContent).toContain(
      'Tell us why AI is useful',
    );
    expect(screen.getByTestId('missing-item-differentiation').textContent).toContain(
      'what makes it different',
    );
  });

  it('states the rule under each one', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /What’s missing\?/ }));
    expect(screen.getByTestId('missing-item-whyAiNecessary').textContent).toContain(
      'Write at least 30 characters',
    );
  });

  it('asks to be taken to the field when a row is clicked', async () => {
    const user = userEvent.setup();
    const onJump = renderPanel();
    await user.click(screen.getByRole('button', { name: /What’s missing\?/ }));
    await user.click(screen.getByTestId('missing-item-whyAiNecessary'));

    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump.mock.calls[0]![0]).toMatchObject({
      path: 'product.whyAiNecessary',
      fieldId: 'whyAiNecessary',
      step: 'product',
    });
  });

  it('disappears entirely when a step is finished', () => {
    const complete = {
      ...PART_FILLED,
      product: {
        ...PART_FILLED.product,
        whyAiNecessary: "AI looks at the user's progress and suggests what to do next.",
        differentiation: 'Most trackers only show numbers. Ours explains what they mean.',
      },
    };
    render(
      <MissingPanel step="product" completeness={evaluateCompleteness(complete)} onJump={vi.fn()} />,
    );
    expect(screen.queryByTestId('missing-panel-product')).toBeNull();
  });

  it('shows nothing about another step', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /What’s missing\?/ }));
    // Live product is entirely empty, and none of it belongs here.
    expect(screen.queryByTestId('missing-item-productUrl')).toBeNull();
    expect(screen.queryByTestId('missing-item-deckArtifactId')).toBeNull();
  });
});
