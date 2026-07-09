import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './providers/AuthProvider';
import { AppShell } from './components/AppShell';
import { SignInPage } from './pages/SignInPage';
import { DashboardPage } from './pages/DashboardPage';
import { ProjectPage } from './pages/ProjectPage';
import { YearPage } from './pages/YearPage';
import { AdminPage } from './pages/AdminPage';
import { CategoriesPage } from './pages/CategoriesPage';
import { AuditLogPage } from './pages/AuditLogPage';
import { HomePage } from './pages/HomePage';
import { ContactsPage } from './pages/ContactsPage';
import { ReportsPage } from './pages/ReportsPage';
import { PublicInvoicePage } from './pages/PublicInvoicePage';
import { MyTasksPage } from './pages/MyTasksPage';
import { TimesheetPage } from './pages/TimesheetPage';
import { LoadingScreen } from './components/LoadingScreen';

function RequireAuth({ children }: { children: JSX.Element }) {
  const { session, loading, profile } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!session) return <Navigate to="/sign-in" replace />;
  if (profile && profile.is_active === false) {
    return (
      <div className="flex h-screen items-center justify-center p-6 text-center">
        <div className="max-w-md space-y-2">
          <h1 className="text-xl font-semibold">Account inactive</h1>
          <p className="text-slate-600">
            Your account is not active yet. Please ask an administrator to enable it.
          </p>
        </div>
      </div>
    );
  }
  return children;
}

function RequireAdmin({ children }: { children: JSX.Element }) {
  const { isAdmin, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!isAdmin) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignInPage />} />
      {/* Public, token-gated: the invoice share link (no auth). */}
      <Route path="/share/invoice/:token" element={<PublicInvoicePage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<HomePage />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="years/:yearId" element={<YearPage />} />
        <Route path="projects/:projectId" element={<ProjectPage />} />
        <Route path="my-tasks" element={<MyTasksPage />} />
        <Route path="timesheet" element={<TimesheetPage />} />
        <Route path="contacts" element={<ContactsPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="categories" element={<CategoriesPage />} />
        <Route
          path="admin"
          element={
            <RequireAdmin>
              <AdminPage />
            </RequireAdmin>
          }
        />
        <Route
          path="admin/audit-log"
          element={
            <RequireAdmin>
              <AuditLogPage />
            </RequireAdmin>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
