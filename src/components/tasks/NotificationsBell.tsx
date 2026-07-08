import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMarkNotificationsRead, useNotifications } from '../../hooks/useTasks';
import type { AppNotification } from '../../types/database';

const KIND_ICONS: Record<AppNotification['kind'], string> = {
  assigned: '📌',
  mention: '💬',
  comment: '💬',
};

/** In-app inbox: assignment + mention notifications, newest first. */
export function NotificationsBell() {
  const notifications = useNotifications();
  const markRead = useMarkNotificationsRead();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const items = notifications.data ?? [];
  const unread = items.filter((n) => !n.read_at);

  function openItem(n: AppNotification) {
    if (!n.read_at) void markRead.mutateAsync([n.id]);
    setOpen(false);
    navigate('/my-tasks');
  }

  return (
    <div className="relative">
      <button
        type="button"
        className="btn-ghost relative"
        aria-label={`Notifications (${unread.length} unread)`}
        onClick={() => setOpen((v) => !v)}
      >
        🔔
        {unread.length > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {unread.length > 9 ? '9+' : unread.length}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 z-40 mt-1 w-80 rounded-lg border border-slate-200 bg-white shadow-xl">
            <header className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Notifications
              </span>
              {unread.length > 0 && (
                <button
                  type="button"
                  className="text-xs text-brand-700 hover:underline"
                  onClick={() => void markRead.mutateAsync(unread.map((n) => n.id))}
                >
                  Mark all read
                </button>
              )}
            </header>
            <ul className="max-h-80 overflow-y-auto">
              {items.length === 0 && (
                <li className="px-3 py-4 text-center text-sm text-slate-400">All quiet.</li>
              )}
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50 ${
                      n.read_at ? 'text-slate-400' : 'text-slate-800'
                    }`}
                    onClick={() => openItem(n)}
                  >
                    <span aria-hidden>{KIND_ICONS[n.kind]}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{n.body}</span>
                      <span className="text-xs text-slate-400">
                        {new Date(n.created_at).toLocaleString()}
                      </span>
                    </span>
                    {!n.read_at && <span className="mt-1 h-2 w-2 flex-none rounded-full bg-brand-500" />}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
