import type { AiClassification } from '@sylvan/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ClassificationBadge } from '../components/ui/ClassificationBadge';

const ai = (overrides: Partial<AiClassification>): AiClassification => ({
  label: 'tree',
  health: null,
  healthConfidence: null,
  confidence: 0.94,
  model: 'm',
  note: null,
  classifiedAt: '2026-09-29T10:00:00.000Z',
  ...overrides,
});

describe('ClassificationBadge', () => {
  it('shows tree and health, each with its confidence', () => {
    render(
      <ClassificationBadge
        sample={{
          classification: null,
          ai: ai({ confidence: 0.97, health: 'unhealthy', healthConfidence: 0.88 }),
        }}
      />,
    );
    expect(screen.getByText(/Tree/)).toHaveTextContent(
      'Tree, confidence 97%· Unhealthy, confidence 88%',
    );
  });

  it('shows objects with their confidence and no health', () => {
    render(
      <ClassificationBadge
        sample={{ classification: null, ai: ai({ label: 'object', confidence: 0.99 }) }}
      />,
    );
    const badge = screen.getByText(/Object/);
    expect(badge).toHaveTextContent('Object, confidence 99%');
    expect(badge).not.toHaveTextContent(/Healthy|Unhealthy/);
  });

  it('shows nothing for anything other than tree or object', () => {
    const { container } = render(
      <ClassificationBadge sample={{ classification: null, ai: ai({ label: 'error' }) }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
