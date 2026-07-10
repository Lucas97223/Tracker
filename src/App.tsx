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
import { PipelinePage } from './pages/PipelinePage';
import { FormsPage } from './pages/FormsPage';
import { PublicFormPage } from './pages/PublicFormPage';
import { TeamPage } from './pages/TeamPage';
import { CatalogPage } from './pages/CatalogPage';
import { ProposalsPage } from './pages/ProposalsPage';
import { ContractsPage } from './pages/ContractsPage';
import { SchedulerPage } from './pages/SchedulerPage';
import { PublicProposalPage } from './pages/PublicProposalPage';
import { PublicContractPage } from './pages/PublicContractPage';
import { PublicBookingPage } from './pages/PublicBookingPage';
import { PortalPage } from './pages/PortalPage';
import { AutomationsPage } from './pages/AutomationsPage';
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
      {/* Public lead-capture form (no auth). */}
      <Route path="/f/:token" element={<PublicFormPage />} />
      <Route path="/p/:token" element={<PublicProposalPage />} />
      <Route path="/c/:token" element={<PublicContractPage />} />
      <Route path="/book/:token" element={<PublicBookingPage />} />
      {/* Client portal: magic-link auth, contact-scoped data (no staff auth). */}
      <Route path="/portal" element={<PortalPage />} />
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
        <Route path="pipeline" element={<PipelinePage />} />
        <Route path="forms" element={<FormsPage />} />
        <Route path="catalog" element={<CatalogPage />} />
        <Route path="proposals" element={<ProposalsPage />} />
        <Route path="contracts" element={<ContractsPage />} />
        <Route path="scheduler" element={<SchedulerPage />} />
        <Route
          path="automations"
          element={
            <RequireAdmin>
              <AutomationsPage />
            </RequireAdmin>
          }
        />
        <Route
          path="team"
          element={
            <RequireAdmin>
              <TeamPage />
            </RequireAdmin>
          }
        />
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
