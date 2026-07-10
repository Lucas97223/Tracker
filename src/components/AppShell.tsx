import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../providers/AuthProvider';
import { Sidebar } from './Sidebar';
import { useRealtimeSync } from '../hooks/useRealtimeSync';
import { SyncStatusBadge } from './SyncStatusBadge';
import { ConflictDialog } from './ConflictDialog';
import { NotificationsBell } from './tasks/NotificationsBell';
import { TimerWidget } from './time/TimerWidget';
import { SearchBox } from './crm/SearchBox';
import { useState } from 'react';
import { useLocation } from 'react-router-dom';

const SALES_LINKS = [
  { to: '/proposals', label: 'Proposals' },
  { to: '/catalog', label: 'Catalog' },
  { to: '/contracts', label: 'Contracts' },
  { to: '/scheduler', label: 'Scheduler' },
  { to: '/forms', label: 'Lead forms' },
  { to: '/automations', label: 'Automations' },
];

function SalesMenu() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const active = SALES_LINKS.some((l) => location.pathname.startsWith(l.to));
  return (
    <div className="relative">
      <button
        type="button"
        className={`rounded px-2.5 py-1 text-sm ${active ? 'bg-slate-100 text-slate-900' : 'text-slate-600 hover:bg-slate-100'}`}
        onClick={() => setOpen((v) => !v)}
      >
        Sales ▾
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute left-0 z-40 mt-1 w-40 rounded-lg border border-slate-200 bg-white py-1 shadow-xl">
            {SALES_LINKS.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                className={({ isActive }) =>
                  `block px-3 py-1.5 text-sm ${isActive ? 'bg-slate-50 text-slate-900' : 'text-slate-600 hover:bg-slate-50'}`
                }
                onClick={() => setOpen(false)}
              >
                {l.label}
              </NavLink>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function AppShell() {
  const { profile, signOut, isAdmin, orgId } = useAuth();
  useRealtimeSync(orgId);
  const navigate = useNavigate();

  async function handleSignOut() {
    await signOut();
    navigate('/sign-in', { replace: true });
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex items-center gap-4">
          <Link to="/" className="text-base font-semibold text-slate-900">
            Expense Tracker
          </Link>
          <nav className="hidden gap-1 md:flex" aria-label="Primary">
            <NavLink
              to="/my-tasks"
              className={({ isActive }) =>
                `rounded px-2.5 py-1 text-sm ${isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-600 hover:bg-slate-100'}`
              }
            >
              My Tasks
            </NavLink>
            <NavLink
              to="/timesheet"
              className={({ isActive }) =>
                `rounded px-2.5 py-1 text-sm ${isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-600 hover:bg-slate-100'}`
              }
            >
              Timesheet
            </NavLink>
            <NavLink
              to="/calendar"
              className={({ isActive }) =>
                `rounded px-2.5 py-1 text-sm ${isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-600 hover:bg-slate-100'}`
              }
            >
              Calendar
            </NavLink>
            <NavLink
              to="/dashboard"
              className={({ isActive }) =>
                `rounded px-2.5 py-1 text-sm ${isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-600 hover:bg-slate-100'}`
              }
            >
              Dashboard
            </NavLink>
            <NavLink
              to="/contacts"
              className={({ isActive }) =>
                `rounded px-2.5 py-1 text-sm ${isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-600 hover:bg-slate-100'}`
              }
            >
              Contacts
            </NavLink>
            <NavLink
              to="/pipeline"
              className={({ isActive }) =>
                `rounded px-2.5 py-1 text-sm ${isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-600 hover:bg-slate-100'}`
              }
            >
              Pipeline
            </NavLink>
            <SalesMenu />
            <NavLink
              to="/reports"
              className={({ isActive }) =>
                `rounded px-2.5 py-1 text-sm ${isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-600 hover:bg-slate-100'}`
              }
            >
              Reports
            </NavLink>
            <NavLink
              to="/categories"
              className={({ isActive }) =>
                `rounded px-2.5 py-1 text-sm ${isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-600 hover:bg-slate-100'}`
              }
            >
              Categories
            </NavLink>
            {isAdmin && (
              <NavLink
                to="/team"
                className={({ isActive }) =>
                  `rounded px-2.5 py-1 text-sm ${isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-600 hover:bg-slate-100'}`
                }
              >
                Team
              </NavLink>
            )}
            {isAdmin && (
              <NavLink
                to="/admin"
                className={({ isActive }) =>
                  `rounded px-2.5 py-1 text-sm ${isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-600 hover:bg-slate-100'}`
                }
              >
                Admin
              </NavLink>
            )}
          </nav>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <SearchBox />
          <TimerWidget />
          <NotificationsBell />
          <SyncStatusBadge />
          <div className="hidden text-right md:block">
            <div className="font-medium text-slate-800">
              {profile?.full_name || profile?.email || '—'}
            </div>
            <div className="text-xs uppercase tracking-wide text-slate-500">{profile?.role}</div>
          </div>
          <button type="button" onClick={handleSignOut} className="btn-ghost">
            Sign out
          </button>
        </div>
      </header>
      <ConflictDialog />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-y-auto bg-slate-50 p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
