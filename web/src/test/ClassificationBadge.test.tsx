import type { AiClassification } from '@sylvan/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ClassificationBadge } from '../components/ui/ClassificationBadge';

const ai = (overrides: Partial<AiClassification>): AiClassification => ({
  label: 'tree',
  health: null,
  confidence: 0.94,
  model: 'm',
  note: null,
  classifiedAt: '2026-09-29T10:00:00.000Z',
  ...overrides,
});

describe('ClassificationBadge', () => {
  it('shows tree health and confidence', () => {
    render(
      <ClassificationBadge sample={{ classification: null, ai: ai({ health: 'unhealthy' }) }} />,
    );
    expect(screen.getByText(/Tree/)).toHaveTextContent('Tree· Unhealthy, confidence 94%');
  });

  it('shows a tree without health when only the tub was visible', () => {
    render(<ClassificationBadge sample={{ classification: null, ai: ai({ confidence: 1 }) }} />);
    const badge = screen.getByText(/Tree/);
    expect(badge).toHaveTextContent('100%');
    expect(badge).not.toHaveTextContent(/Healthy|Unhealthy/);
  });

  it("falls back to the rover's verdict when the server has none", () => {
    render(<ClassificationBadge sample={{ classification: 'object', ai: null }} />);
    expect(screen.getByText(/Object/)).toBeInTheDocument();
  });
});
