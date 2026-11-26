import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AskContext } from '@/app/actions/chat';

const newThreadAction = vi.fn(async () => 't-new');
const threadMessagesAction = vi.fn(async () => []);
const setThreadModeAction = vi.fn(async () => {});
vi.mock('@/app/actions/chat', () => ({ newThreadAction, threadMessagesAction, setThreadModeAction }));
vi.mock('@/components/project-context', () => ({ useProject: () => ({ base: '/p/x' }) }));
vi.mock('./spend-banner', () => ({ SpendBanner: () => null }));
vi.mock('./thread-view', () => ({
  ThreadView: ({ threadId, onEnsureThread }: { threadId: string | null; onEnsureThread?: () => Promise<string> }) => (
    <div>
      <span data-testid="tv-id">{threadId ?? 'none'}</span>
      <button type="button" onClick={() => void onEnsureThread?.()}>
        send
      </button>
    </div>
  ),
}));

const { AskSlideover } = await import('./ask-slideover');

const ctx = (): AskContext => ({
  summary: { state: 'ok' } as AskContext['summary'],
  configured: true,
  titles: [],
  threads: [{ id: 't-old', title: 'Old chat', updatedAt: new Date(), mode: 'default' }],
  messages: [],
  note: null,
});

const renderPanel = (props: Partial<React.ComponentProps<typeof AskSlideover>> = {}) =>
  render(<AskSlideover slug="c1" open onClose={() => {}} documentId="d1" context={ctx()} {...props} />);
const options = () => screen.getByLabelText('Chat').querySelectorAll('option');

beforeEach(() => {
  newThreadAction.mockClear();
  threadMessagesAction.mockClear();
  setThreadModeAction.mockClear();
});

describe('AskSlideover lazy New chat', () => {
  it('New chat makes no server call and shows an unsaved placeholder', () => {
    renderPanel();
    expect(screen.getByTestId('tv-id')).toHaveTextContent('t-old');
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(newThreadAction).not.toHaveBeenCalled();
    expect(options()).toHaveLength(2);
    expect(screen.getByTestId('tv-id')).toHaveTextContent('none');
  });

  it('the first send creates the chat in scope and selects it', async () => {
    renderPanel({ questionId: null });
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'send' })));
    expect(newThreadAction).toHaveBeenCalledOnce();
    expect(newThreadAction).toHaveBeenCalledWith('c1', 'd1', { mode: 'default', questionId: null });
    expect(screen.getByTestId('tv-id')).toHaveTextContent('t-new');
    expect((screen.getByLabelText('Chat') as HTMLSelectElement).value).toBe('t-new');
  });

  it('keeps the tutor Full solution choice locally until the first send', async () => {
    renderPanel({ questionId: 'q1', mode: 'tutor-hint' });
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    const toggle = screen.getByRole('checkbox');
    expect(toggle).toBeEnabled();
    await act(async () => fireEvent.click(toggle));
    expect(toggle).toBeChecked();
    expect(setThreadModeAction).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'send' })));
    expect(newThreadAction).toHaveBeenCalledWith('c1', 'd1', { mode: 'tutor-full', questionId: 'q1' });
  });

  it('can switch to an existing chat from the placeholder state', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Chat'), { target: { value: 't-old' } });
    });
    expect(threadMessagesAction).toHaveBeenCalledWith('c1', 't-old');
    expect(screen.getByTestId('tv-id')).toHaveTextContent('t-old');
  });
});
