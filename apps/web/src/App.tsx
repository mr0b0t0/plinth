// Route table. Each page file belongs to one workstream; this file only maps paths to pages.
import { APP_ROUTES } from "@plinth/shared";
import { type ComponentType, lazy, Suspense } from "react";
import { matchPath, useLocation } from "./lib/router.tsx";

type Page = ComponentType<{ params: Record<string, string> }>;

// biome-ignore lint/suspicious/noExplicitAny: pages declare their own props
const page = (load: () => Promise<{ default: ComponentType<any> }>) => lazy(load) as Page;

const Home = page(() => import("./pages/Home.tsx"));
const Login = page(() => import("./pages/Login.tsx"));
const Magic = page(() => import("./pages/Magic.tsx"));
const ReviewLogin = page(() => import("./pages/ReviewLogin.tsx"));
const Dashboard = page(() => import("./pages/Dashboard.tsx"));
const Connections = page(() => import("./pages/Connections.tsx"));
const Consent = page(() => import("./pages/Consent.tsx"));
const ArtifactPage = page(() => import("./pages/ArtifactPage.tsx"));
const History = page(() => import("./pages/History.tsx"));
const Compare = page(() => import("./pages/Compare.tsx"));
const Editor = page(() => import("./pages/Editor.tsx"));
const Settings = page(() => import("./pages/Settings.tsx"));
const ArtifactStats = page(() => import("./pages/ArtifactStats.tsx"));
const Open = page(() => import("./pages/Open.tsx"));
const Report = page(() => import("./pages/Report.tsx"));
const AdminReports = page(() => import("./pages/AdminReports.tsx"));
const AdminStats = page(() => import("./pages/AdminStats.tsx"));
const Design = page(() => import("./pages/Design.tsx"));
const Legal = page(() => import("./pages/Legal.tsx"));
const NotFound = page(() => import("./pages/NotFound.tsx"));

export const ROUTES: [string, Page][] = [
  [APP_ROUTES.home, Home],
  [APP_ROUTES.login, Login],
  [APP_ROUTES.magic, Magic],
  [APP_ROUTES.reviewLogin, ReviewLogin],
  [APP_ROUTES.dashboard, Dashboard],
  [APP_ROUTES.connections, Connections],
  [APP_ROUTES.consent, Consent],
  [APP_ROUTES.artifact, ArtifactPage],
  [APP_ROUTES.artifactVersion, ArtifactPage],
  [APP_ROUTES.history, History],
  [APP_ROUTES.compare, Compare],
  [APP_ROUTES.editor, Editor],
  [APP_ROUTES.settings, Settings],
  [APP_ROUTES.artifactStats, ArtifactStats],
  [APP_ROUTES.open, Open],
  [APP_ROUTES.report, Report],
  [APP_ROUTES.adminReports, AdminReports],
  [APP_ROUTES.adminStats, AdminStats],
  [APP_ROUTES.design, Design],
  ["/legal/:doc", Legal],
];

export function App() {
  const { pathname } = useLocation();
  let match: { Page: Page; params: Record<string, string> } = { Page: NotFound, params: {} };
  for (const [pattern, Page] of ROUTES) {
    const params = matchPath(pattern, pathname);
    if (params) {
      match = { Page, params };
      break;
    }
  }
  const { Page, params } = match;
  return (
    <Suspense fallback={null}>
      <Page params={params} />
    </Suspense>
  );
}
