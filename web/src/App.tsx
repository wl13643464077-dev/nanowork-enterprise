import { lazy, Suspense, useEffect, useState } from 'react';
import { Spin } from 'antd';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { bootstrapSession, getUser } from './api/client';
import MainLayout from './layouts/MainLayout';
import Login from './pages/Login';

const Register = lazy(() => import('./pages/Register'));
const Pending = lazy(() => import('./pages/Pending'));
const Platform = lazy(() => import('./pages/Platform'));
const Recharge = lazy(() => import('./pages/Recharge'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Advisor = lazy(() => import('./pages/Advisor'));
const Employees = lazy(() => import('./pages/Employees'));
const Toolbox = lazy(() => import('./pages/Toolbox'));
const Growth = lazy(() => import('./pages/Growth'));
const Activities = lazy(() => import('./pages/Activities'));
const ContentFactory = lazy(() => import('./pages/ContentFactory'));
const Execution = lazy(() => import('./pages/Execution'));
const Analysis = lazy(() => import('./pages/Analysis'));
const StoreData = lazy(() => import('./pages/StoreData'));
const Assets = lazy(() => import('./pages/Assets'));
const System = lazy(() => import('./pages/System'));
const Admin = lazy(() => import('./pages/Admin'));
const Mobile = lazy(() => import('./pages/Mobile'));

function Protected({ children }: { children: JSX.Element }) {
  return getUser() ? children : <Navigate to="/login" replace />;
}
// 企业业务壳层：平台超管只使用跨租户平台控制台，不进入任何单企业业务页面。
function EnterpriseOnly({ children }: { children: JSX.Element }) {
  const user = getUser();
  if (!user) return <Navigate to="/login" replace />;
  return user.role === 'platform_super' ? <Navigate to="/platform" replace /> : children;
}
// 平台超管专属
function PlatformOnly({ children }: { children: JSX.Element }) {
  if (!getUser()) return <Navigate to="/login" replace />;
  return getUser()?.role === 'platform_super' ? children : <Navigate to="/" replace />;
}

const MODULE_HOME: Record<string, string> = {
  dashboard: '/',
  advisor: '/advisor',
  marshals: '/employees',
  content: '/content',
  growth: '/growth',
  activities: '/activities',
  execution: '/execution',
  analysis: '/analysis',
  assets: '/assets',
  system: '/system',
};

function ModuleOnly({ moduleKey, children }: { moduleKey: string; children: JSX.Element }) {
  const user = getUser();
  if (!user) return <Navigate to="/login" replace />;
  const modules = Array.isArray(user.modules) ? user.modules : [];
  if (modules.includes(moduleKey)) return children;
  const fallback = Object.entries(MODULE_HOME).find(([key]) => modules.includes(key))?.[1] || '/login';
  return <Navigate to={fallback} replace />;
}

function RoleOnly({ roles, children }: { roles: string[]; children: JSX.Element }) {
  const user = getUser();
  if (!user) return <Navigate to="/login" replace />;
  return roles.includes(user.role) ? children : <Navigate to="/" replace />;
}

function SessionGate({ children }: { children: JSX.Element }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    bootstrapSession().finally(() => setReady(true));
  }, []);
  if (!ready)
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--ui-bg)' }}>
        <Spin size="large" />
      </div>
    );
  return children;
}

const routeFallback = (
  <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--ui-bg)' }}>
    <Spin size="large" />
  </div>
);

export default function App() {
  return (
    <SessionGate>
      <BrowserRouter>
        <Suspense fallback={routeFallback}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route
              path="/pending"
              element={
                <Protected>
                  <Pending />
                </Protected>
              }
            />
            <Route
              path="/platform"
              element={
                <PlatformOnly>
                  <Platform />
                </PlatformOnly>
              }
            />
            <Route
              path="/admin"
              element={
                <RoleOnly roles={['boss', 'admin']}>
                  <Admin />
                </RoleOnly>
              }
            />
            <Route
              path="/m"
              element={
                <EnterpriseOnly>
                  <Mobile />
                </EnterpriseOnly>
              }
            />
            <Route
              element={
                <EnterpriseOnly>
                  <MainLayout />
                </EnterpriseOnly>
              }
            >
              <Route
                path="/"
                element={
                  <ModuleOnly moduleKey="dashboard">
                    <Dashboard />
                  </ModuleOnly>
                }
              />
              <Route
                path="/advisor"
                element={
                  <ModuleOnly moduleKey="advisor">
                    <Advisor />
                  </ModuleOnly>
                }
              />
              <Route
                path="/employees"
                element={
                  <ModuleOnly moduleKey="marshals">
                    <Employees />
                  </ModuleOnly>
                }
              />
              <Route
                path="/marshals"
                element={
                  <ModuleOnly moduleKey="marshals">
                    <Navigate to="/employees" replace />
                  </ModuleOnly>
                }
              />
              <Route
                path="/toolbox"
                element={
                  <ModuleOnly moduleKey="content">
                    <Toolbox />
                  </ModuleOnly>
                }
              />
              <Route
                path="/growth"
                element={
                  <ModuleOnly moduleKey="growth">
                    <Growth />
                  </ModuleOnly>
                }
              />
              <Route
                path="/activities"
                element={
                  <ModuleOnly moduleKey="activities">
                    <Activities />
                  </ModuleOnly>
                }
              />
              <Route
                path="/content"
                element={
                  <ModuleOnly moduleKey="content">
                    <ContentFactory />
                  </ModuleOnly>
                }
              />
              <Route
                path="/execution"
                element={
                  <ModuleOnly moduleKey="execution">
                    <Execution />
                  </ModuleOnly>
                }
              />
              <Route
                path="/analysis"
                element={
                  <ModuleOnly moduleKey="analysis">
                    <Analysis />
                  </ModuleOnly>
                }
              />
              <Route
                path="/store-data"
                element={
                  <ModuleOnly moduleKey="analysis">
                    <StoreData />
                  </ModuleOnly>
                }
              />
              <Route
                path="/assets"
                element={
                  <ModuleOnly moduleKey="assets">
                    <Assets />
                  </ModuleOnly>
                }
              />
              <Route
                path="/data-intake"
                element={
                  <ModuleOnly moduleKey="system">
                    <Navigate to="/system?tab=data-intake" replace />
                  </ModuleOnly>
                }
              />
              <Route
                path="/system"
                element={
                  <ModuleOnly moduleKey="system">
                    <System />
                  </ModuleOnly>
                }
              />
              <Route
                path="/recharge"
                element={
                  <RoleOnly roles={['boss']}>
                    <Recharge />
                  </RoleOnly>
                }
              />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </SessionGate>
  );
}
