import { type CommandView, describeCommand } from '@/lib/lemida/command-view';
import s from './command-status.module.css';

function Row({ name, testId, c, now }: { name: string; testId: string; c: CommandView | null; now: Date }) {
  if (!c) {
    return (
      <div className={s.row} data-testid={testId} data-status="idle">
        <span className={s.name}>{name}</span>
        <span className={s.text}>idle</span>
      </div>
    );
  }
  const d = describeCommand(c, now);
  return (
    <div className={s.row} data-testid={testId} data-status={c.status} data-tone={d.tone}>
      <span className={s.name}>{name}</span>
      <span className={s.text}>
        <strong>{d.label}</strong> — {d.text}
      </span>
    </div>
  );
}

export function CommandStatus({ current, last }: { current: CommandView | null; last: CommandView | null }) {
  const now = new Date();
  return (
    <div className={s.wrap}>
      <Row name="Now" testId="lemida-command-current" c={current} now={now} />
      {last && <Row name="Last" testId="lemida-command-last" c={last} now={now} />}
    </div>
  );
}
