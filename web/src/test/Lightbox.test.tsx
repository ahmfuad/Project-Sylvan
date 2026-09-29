import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Lightbox } from '../components/Lightbox';
import { makeSample } from './fixtures';
import { renderRoute } from './render';

const samples = [
  makeSample({ id: 30, createdAt: '2026-09-17T08:00:00Z' }),
  makeSample({
    id: 29,
    createdAt: '2026-09-17T07:00:00Z',
    ok: false,
    temperature: null,
    humidity: null,
    lux: null,
    fallback: { temperature: 27.5, humidity: 64, lux: 900 },
  }),
  makeSample({ id: 28, createdAt: '2026-09-17T06:00:00Z' }),
];

function Harness() {
  const [index, setIndex] = useState<number | null>(null);
  const [lastId, setLastId] = useState<number | null>(null);
  return (
    <>
      {samples.map((sample, i) => (
        <button
          key={sample.id}
          type="button"
          data-sample-id={sample.id}
          onClick={() => {
            setLastId(sample.id);
            setIndex(i);
          }}
        >
          Open #{sample.id}
        </button>
      ))}
      <Lightbox
        samples={samples}
        index={index}
        onIndexChange={(next) => {
          if (next !== null) setLastId(samples[next]?.id ?? null);
          setIndex(next);
        }}
        returnFocus={() => document.querySelector(`[data-sample-id="${String(lastId)}"]`)}
      />
    </>
  );
}

describe('Lightbox', () => {
  it('opens a photo, moves with arrow keys and closes with Escape', async () => {
    const user = userEvent.setup();
    renderRoute(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open #30' });
    await user.click(opener);

    const dialog = await screen.findByRole('dialog', { name: 'Sample #30' });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(screen.getByRole('button', { name: 'Previous photo' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute(
      'download',
      'sylvan-sample-30.jpg',
    );
    expect(screen.getByRole('link', { name: 'Open details' })).toHaveAttribute(
      'href',
      '/samples/30',
    );

    await user.keyboard('{ArrowRight}');
    // A failed sample shows the fallback values and no failure text in production.
    const failed = screen.getByRole('dialog', { name: 'Sample #29' });
    expect(failed).toHaveTextContent('27.5');
    expect(failed).not.toHaveTextContent(/failed/i);
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('dialog', { name: 'Sample #28' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next photo' })).toBeDisabled();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('dialog', { name: 'Sample #28' })).toBeInTheDocument();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('dialog', { name: 'Sample #29' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Focus returns to the card of the photo that was showing.
    expect(screen.getByRole('button', { name: 'Open #29' })).toHaveFocus();
  });

  it('traps focus inside and restores it to the opener when closed without navigating', async () => {
    const user = userEvent.setup();
    renderRoute(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open #28' });
    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Sample #28' });

    for (let i = 0; i < 8; i++) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
